// wiki-plugin-semindex — embedding facade, child-process supervisor (CommonJS)
//
// Promise API over the fork()ed embed-child.js. This module is a process-wide
// singleton (require cache), shared by every farm site instance and — via
// require('wiki-plugin-semindex/server/embed-lib.js') — by other plugins
// (wiki-plugin-similarity delegates query embedding here when installed).
//
// Since 0.2.0 the embedder is a child PROCESS, not a worker thread: a worker
// isolates neither native aborts nor out-of-memory kills, so a fatal error in
// the ONNX runtime could still take down the whole farm process (the failure
// mode behind the 2026-07-22 hitchhikers.earth outage). Supervision matches
// wiki-plugin-similarity 0.9.0:
//
//   - lazy fork on first use, V8 heap capped via --max-old-space-size
//     (WIKI_EMBED_CHILD_HEAP_MB, default 512)
//   - per-request timeout (WIKI_SEMINDEX_TIMEOUT_MS, default 5 min — the
//     first embed includes model load and possibly the one-time download;
//     the indexer embeds serially, so queue depth stays shallow)
//   - circuit breaker: WIKI_EMBED_MAX_CRASHES abnormal exits (default 3)
//     within WIKI_EMBED_CRASH_WINDOW_MS (default 10 min) opens the breaker
//     for WIKI_EMBED_COOLDOWN_MS (default 5 min); while open, embed()
//     rejects immediately with err.code = 'EMBEDDER_DOWN'
//   - deliberate stops (idle timer, stop()) never count as crashes
//
// The child spawns on first use and is stopped after WIKI_SEMINDEX_IDLE_MS
// without traffic, returning the model's ~0.5GB RSS to the OS. A later embed
// pays a few seconds of model reload from disk cache.

const { fork } = require('node:child_process')
const path = require('node:path')

const IDLE_MS = Math.max(60_000,
  parseInt(process.env.WIKI_SEMINDEX_IDLE_MS || '600000', 10) || 600_000)
const HEAP_MB         = parseInt(process.env.WIKI_EMBED_CHILD_HEAP_MB) || 512
const TIMEOUT_MS      = parseInt(process.env.WIKI_SEMINDEX_TIMEOUT_MS) || 5 * 60_000
const MAX_CRASHES     = parseInt(process.env.WIKI_EMBED_MAX_CRASHES) || 3
const CRASH_WINDOW_MS = parseInt(process.env.WIKI_EMBED_CRASH_WINDOW_MS) || 10 * 60_000
const COOLDOWN_MS     = parseInt(process.env.WIKI_EMBED_COOLDOWN_MS) || 5 * 60_000

const MODEL_META = {
  model: process.env.WIKI_EMBED_MODEL || 'BAAI/bge-small-en-v1.5',
  dim: 384,
  quantized: process.env.WIKI_EMBED_QUANTIZED === '1',
}

const embedderError = (message, code) => {
  const e = new Error(message)
  if (code) e.code = code
  return e
}

const state = {
  child: null,
  stopping: false,    // deliberate termination in progress — not a crash
  pending: new Map(), // id -> {resolve, reject, timer}
  nextId: 1,
  backend: null,      // 'native' | 'wasm' once known
  download: null,     // {file, pct} while the model downloads
  error: null,
  idleTimer: null,
  crashTimes: [],
  breakerOpenUntil: 0,
}

const breakerOpen = () => Date.now() < state.breakerOpenUntil

const rejectPending = err => {
  for (const p of state.pending.values()) {
    clearTimeout(p.timer)
    p.reject(err)
  }
  state.pending.clear()
}

const stopChild = () => {
  if (state.child) {
    state.stopping = true
    state.child.kill()
    state.child = null
  }
}

const bumpIdle = () => {
  clearTimeout(state.idleTimer)
  state.idleTimer = setTimeout(() => {
    if (!state.pending.size) stopChild()
  }, IDLE_MS)
  if (state.idleTimer.unref) state.idleTimer.unref()
}

const getChild = () => {
  if (!state.child) {
    const c = fork(path.join(__dirname, 'embed-child.js'), [], {
      execArgv: [`--max-old-space-size=${HEAP_MB}`],
    })
    state.stopping = false
    // Never keep the wiki process alive on our account.
    c.unref()
    if (c.channel && c.channel.unref) c.channel.unref()
    c.on('message', msg => {
      if (msg.type === 'progress') { state.download = { file: msg.file, pct: msg.pct }; return }
      if (msg.type === 'ready')    { state.backend = msg.backend; state.download = null; state.error = null; return }
      const p = state.pending.get(msg.id)
      if (!p) return
      state.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(msg.vector)
      bumpIdle()
    })
    c.on('error', err => {
      state.error = String((err && err.message) || err)
      rejectPending(err)
      if (state.child === c) state.child = null
    })
    c.on('exit', (code, signal) => {
      const deliberate = state.stopping || (code === 0 && !signal)
      if (state.child === c) state.child = null
      const why = signal ? `signal ${signal}` : `code ${code}`
      rejectPending(embedderError(`embedder process exited (${why})`))
      if (deliberate) return
      state.error = `embed child exited: ${why}`
      console.error(`[wiki-plugin-semindex] ${state.error}`)
      const now = Date.now()
      state.crashTimes = state.crashTimes.filter(t => now - t < CRASH_WINDOW_MS)
      state.crashTimes.push(now)
      if (state.crashTimes.length >= MAX_CRASHES) {
        state.breakerOpenUntil = now + COOLDOWN_MS
        console.error(`[wiki-plugin-semindex] ${state.crashTimes.length} embedder crashes in ` +
          `${Math.round(CRASH_WINDOW_MS / 60_000)} min — embedding disabled for ` +
          `${Math.round(COOLDOWN_MS / 60_000)} min`)
      }
    })
    state.child = c
  }
  return state.child
}

// Embed one text → number[384], unit-normalised.
const embed = text => {
  if (breakerOpen()) {
    return Promise.reject(embedderError(
      'embedding temporarily unavailable (embedder crashed repeatedly, cooling down)',
      'EMBEDDER_DOWN'))
  }
  return new Promise((resolve, reject) => {
    const id = state.nextId++
    const timer = setTimeout(() => {
      state.pending.delete(id)
      reject(embedderError(`embed timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    if (timer.unref) timer.unref()
    state.pending.set(id, { resolve, reject, timer })
    try {
      getChild().send({ id, text })
    } catch (e) {
      state.pending.delete(id)
      clearTimeout(timer)
      reject(embedderError(`embedder unavailable: ${e.message}`))
    }
    bumpIdle()
  })
}

const status = () => ({
  loaded: !!state.child,
  backend: state.backend,
  download: state.download,
  error: state.error,
  pending: state.pending.size,
  isolation: 'child-process',
  recentCrashes: state.crashTimes.filter(t => Date.now() - t < CRASH_WINDOW_MS).length,
  breakerOpenUntil: breakerOpen() ? new Date(state.breakerOpenUntil).toISOString() : null,
})

module.exports = { embed, status, stop: stopChild, MODEL_META }
