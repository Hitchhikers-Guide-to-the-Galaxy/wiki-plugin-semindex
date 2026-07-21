// wiki-plugin-semindex — the indexer (CommonJS)
//
// Ports ~/src/fedwiki-index/build_index.py: per-site, one vector per page
// (title + markdown/paragraph item text), written to
// {site}/status/semantic-vectors.json  [{slug,title,vector}]   (unchanged shape)
// {site}/status/semantic-meta.json     [{slug,title,mtime}]    (mtime added)
// {site}/status/semantic-state.json    {model,dim,quantized,builtAt,pages}
//
// Incremental: pages whose mtime is newer than the recorded meta mtime (or
// absent from it — including every page of a Python-built index, which carried
// no mtimes) are re-embedded; everything else reuses its stored vector.
//
// Process model: this module is a require-cache singleton, so N per-site farm
// instances share ONE scheduler, queue, and worker. Cross-process safety comes
// from a heartbeat lockfile in {farmRoot}/.semindex/; cross-MACHINE safety on
// Nextcloud-synced farms is policy (WIKI_SEMINDEX_MODE) — one writer per farm.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const embedLib = require('./embed-lib')
const { listSites, farmRootOf, globMatch, hasNoindex } = require('./farm')

const USEFUL_TYPES = new Set(['markdown', 'paragraph'])

const intEnv = (name, dflt) => parseInt(process.env[name] || '', 10) || dflt
const MODE        = ['off', 'query-only', 'writer'].includes(process.env.WIKI_SEMINDEX_MODE)
  ? process.env.WIKI_SEMINDEX_MODE : 'writer'
const SCAN_MS     = intEnv('WIKI_SEMINDEX_SCAN_MS', 600_000)
const SETTLE_MS   = intEnv('WIKI_SEMINDEX_SETTLE_MS', 300_000)
const THROTTLE_MS = intEnv('WIKI_SEMINDEX_THROTTLE_MS', 50)
const MIN_PAGES   = intEnv('WIKI_SEMINDEX_MIN_PAGES', 1)
const MAINTENANCE = process.env.WIKI_SEMINDEX_MAINTENANCE === '1'
const STALE_LOCK_MS = 300_000

const state = {
  started: false,
  argv: null,
  root: null,
  queue: [],        // [{domain, force}]
  building: null,   // {domain, done, total, startedAt}
  draining: false,
  lastBuild: {},    // domain -> {at, pages, embedded, ms} | {at, error}
  scanTimer: null,
  ownsLock: false,
  heartbeatTimer: null,
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Extraction — exact port of build_index.py ────────────────────────────────

const extractText = page => {
  const parts = [page.title || '']
  for (const item of page.story || []) {
    if (USEFUL_TYPES.has(item.type)) {
      const text = (item.text || '').trim()
      if (text) parts.push(text)
    }
  }
  return parts.join('\n')
}

const loadPages = pagesDir => {
  let names
  try { names = fs.readdirSync(pagesDir).sort() } catch { return [] }
  const out = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const p = path.join(pagesDir, name)
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) continue
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      const text = extractText(data)
      if (!text.trim()) continue
      out.push({ slug: name, title: data.title || name, text, mtime: st.mtimeMs / 1000 })
    } catch { /* unreadable page — skip, as the Python did */ }
  }
  return out
}

const newestPageMtime = pagesDir => {
  let newest = 0
  try {
    for (const name of fs.readdirSync(pagesDir)) {
      try {
        const st = fs.statSync(path.join(pagesDir, name))
        if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return newest
}

// ── Lock + maintenance flag ({farmRoot}/.semindex/) ──────────────────────────

const metaDir = () => path.join(state.root, '.semindex')
const lockPath = () => path.join(metaDir(), 'lock.json')
const maintenancePath = () => path.join(metaDir(), 'maintenance.json')

const acquireLock = () => {
  try { fs.mkdirSync(metaDir(), { recursive: true }) } catch { /* ignore */ }
  const payload = JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath(), payload, { flag: 'wx' })
      state.ownsLock = true
      return true
    } catch {
      try {
        const age = Date.now() - fs.statSync(lockPath()).mtimeMs
        if (age > STALE_LOCK_MS) { fs.unlinkSync(lockPath()); continue } // stale — take over
      } catch { continue } // vanished between checks — retry
      return false
    }
  }
  return false
}

const releaseLock = () => {
  if (!state.ownsLock) return
  try { fs.unlinkSync(lockPath()) } catch { /* ignore */ }
  state.ownsLock = false
}

const heartbeat = start => {
  clearInterval(state.heartbeatTimer)
  if (start) {
    state.heartbeatTimer = setInterval(() => {
      const now = new Date()
      try { fs.utimesSync(lockPath(), now, now) } catch { /* ignore */ }
    }, 30_000)
    if (state.heartbeatTimer.unref) state.heartbeatTimer.unref()
  }
}

const writeMaintenanceFlag = () => {
  if (!MAINTENANCE) return
  try {
    fs.mkdirSync(metaDir(), { recursive: true })
    fs.writeFileSync(maintenancePath(), JSON.stringify({
      ...state.building, queue: state.queue.map(j => j.domain), updated: Date.now(),
    }))
  } catch { /* ignore */ }
}

const clearMaintenanceFlag = () => {
  try { fs.unlinkSync(maintenancePath()) } catch { /* ignore */ }
}

// ── Freshness (build_index.py index_is_fresh + settle delay) ─────────────────

const staleness = (domain, { settle = true } = {}) => {
  const siteDir = path.join(state.root, domain)
  const newest = newestPageMtime(path.join(siteDir, 'pages'))
  let indexMtime = 0
  try { indexMtime = fs.statSync(path.join(siteDir, 'status', 'semantic-vectors.json')).mtimeMs } catch { /* absent */ }
  if (!indexMtime) return { stale: true, cold: true }
  if (newest <= indexMtime) return { stale: false }
  // stale — but let an editing session settle before rebuilding
  return { stale: !settle || Date.now() - newest > SETTLE_MS }
}

// ── Building ─────────────────────────────────────────────────────────────────

const readJson = (p, dflt) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return dflt }
}

const writeAtomic = (p, data) => {
  const tmp = `${p}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, p)
}

const buildSite = async ({ domain, force }) => {
  const siteDir = path.join(state.root, domain)
  const statusDir = path.join(siteDir, 'status')
  const vectorsPath = path.join(statusDir, 'semantic-vectors.json')
  const t0 = Date.now()

  const pages = loadPages(path.join(siteDir, 'pages'))
  if (pages.length < MIN_PAGES) return

  const prevState = readJson(path.join(statusDir, 'semantic-state.json'), null)
  const modelMatch = prevState &&
    prevState.model === embedLib.MODEL_META.model &&
    prevState.quantized === embedLib.MODEL_META.quantized
  const fullRebuild = force || !modelMatch

  const prevVectors = new Map(
    (readJson(vectorsPath, [])).map(e => [e.slug, e.vector]))
  const prevMeta = new Map(
    (readJson(path.join(statusDir, 'semantic-meta.json'), [])).map(e => [e.slug, e]))
  const indexMtimeBefore = (() => {
    try { return fs.statSync(vectorsPath).mtimeMs } catch { return 0 }
  })()

  const needsEmbed = p => {
    if (fullRebuild) return true
    const meta = prevMeta.get(p.slug)
    if (!meta || meta.mtime == null) return true // Python-built meta carries no mtime
    return p.mtime > meta.mtime || !prevVectors.has(p.slug)
  }
  const jobs = pages.filter(needsEmbed)
  if (!jobs.length && prevVectors.size === pages.length) return // nothing to do

  state.building = { domain, done: 0, total: jobs.length, startedAt: t0 }
  writeMaintenanceFlag()
  console.log(`[wiki-plugin-semindex] ${domain}: ${pages.length} pages, embedding ${jobs.length}`)

  const fresh = new Map()
  for (const p of jobs) {
    fresh.set(p.slug, await embedLib.embed(p.text))
    state.building.done++
    writeMaintenanceFlag()
    if (THROTTLE_MS) await sleep(THROTTLE_MS)
  }

  // Belt-and-braces: if another writer produced a newer index mid-build, yield.
  const indexMtimeAfter = (() => {
    try { return fs.statSync(vectorsPath).mtimeMs } catch { return 0 }
  })()
  if (indexMtimeAfter > indexMtimeBefore) {
    console.log(`[wiki-plugin-semindex] ${domain}: index changed mid-build by another writer — skipping write`)
    return
  }

  fs.mkdirSync(statusDir, { recursive: true })
  const payload = pages.map(p => ({
    slug: p.slug, title: p.title,
    vector: fresh.get(p.slug) || prevVectors.get(p.slug),
  }))
  writeAtomic(vectorsPath, JSON.stringify(payload))
  writeAtomic(path.join(statusDir, 'semantic-meta.json'),
    JSON.stringify(pages.map(p => ({ slug: p.slug, title: p.title, mtime: p.mtime }))))
  writeAtomic(path.join(statusDir, 'semantic-state.json'), JSON.stringify({
    ...embedLib.MODEL_META, builtAt: Date.now(), pages: pages.length,
  }))

  state.lastBuild[domain] = {
    at: Date.now(), pages: pages.length, embedded: jobs.length, ms: Date.now() - t0,
  }
  console.log(`[wiki-plugin-semindex] ${domain}: built in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

const drain = async () => {
  if (state.draining || !state.queue.length) return
  state.draining = true
  if (!acquireLock()) {
    console.log('[wiki-plugin-semindex] another indexer holds the lock — deferring')
    state.draining = false
    return
  }
  heartbeat(true)
  try {
    while (state.queue.length) {
      const job = state.queue.shift()
      try {
        await buildSite(job)
      } catch (e) {
        state.lastBuild[job.domain] = { at: Date.now(), error: String((e && e.message) || e) }
        console.log(`[wiki-plugin-semindex] ${job.domain}: build failed —`, e)
      }
      state.building = null
    }
  } finally {
    heartbeat(false)
    releaseLock()
    clearMaintenanceFlag()
    state.building = null
    state.draining = false
  }
}

// ── Queue + scan ─────────────────────────────────────────────────────────────

const enqueue = (domain, force = false) => {
  if (state.building?.domain === domain) return false
  const queued = state.queue.find(j => j.domain === domain)
  if (queued) { queued.force = queued.force || force; return false }
  state.queue.push({ domain, force })
  return true
}

const scan = () => {
  if (MODE !== 'writer') return
  for (const { root, domain } of listSites(state.argv)) {
    if (root !== state.root) continue
    if (hasNoindex(root, domain)) continue
    if (staleness(domain).stale) enqueue(domain)
  }
  if (state.queue.length) drain()
}

// Admin trigger: comma-separated globs → enqueue matches, skip the settle delay.
const enqueueGlobs = (globs, force = false) => {
  const patterns = (globs || '*').split(',').map(s => s.trim()).filter(Boolean)
  const queued = []
  for (const { root, domain } of listSites(state.argv)) {
    if (hasNoindex(root, domain)) continue
    if (!patterns.some(p => globMatch(p, domain))) continue
    // triggered builds skip the settle delay
    if (force || staleness(domain, { settle: false }).stale) {
      if (enqueue(domain, force)) queued.push(domain)
    }
  }
  drain()
  return queued
}

// ── Status + init ────────────────────────────────────────────────────────────

const status = () => {
  const embedder = embedLib.status()
  return {
    plugin: 'wiki-plugin-semindex',
    mode: MODE,
    state: state.building ? 'building' : embedder.download ? 'downloading' : 'idle',
    building: state.building,
    queue: state.queue.map(j => j.domain),
    lastBuild: state.lastBuild,
    embedder,
    ...embedLib.MODEL_META,
  }
}

const init = argv => {
  if (state.started) return
  state.started = true
  state.argv = argv
  state.root = farmRootOf(argv)
  console.log(`[wiki-plugin-semindex] mode=${MODE} farm root=${state.root}`)
  if (MODE !== 'writer') return
  // First scan after a short grace so farm boot isn't competing with embedding.
  const first = setTimeout(scan, 30_000)
  if (first.unref) first.unref()
  state.scanTimer = setInterval(scan, SCAN_MS)
  if (state.scanTimer.unref) state.scanTimer.unref()
}

module.exports = { init, status, enqueueGlobs, scan, MODE }
