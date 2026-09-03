// wiki-plugin-semindex — server-side component
//
// The farm's semantic-index WRITER: builds semantic-vectors.json for every
// site in the farm, in-process, in a worker thread — the JS replacement for
// the Python/FastAPI indexer (build_index.py / pi5-semantic-index.service).
// wiki-plugin-similarity is the matching READER; installed together they give
// a wiki full federated semantic search with no external services.
//
// Routes (registered per site, like every plugin server):
//   GET  /system/semindex-status.json
//     Build/queue/download status — polled by the SemIndex client widget.
//   GET|POST /system/semindex-build.json?domains=glob1,glob2&force=1
//     Enqueue index builds. Owner/admin only (403 otherwise). Mirrors the
//     old FastAPI /build-index contract so a REMOTE similarity plugin can
//     use this wiki as its WIKI_INDEXER_URL.
//   GET  /system/semindex-embed.json?text=…
//     Embed one text (same contract as similarity's /system/embed.json) so a
//     remote slim similarity can point WIKI_EMBED_URL here. Rate-limited.
//
// Env: WIKI_SEMINDEX_MODE off|query-only|writer (default writer — one writer
// per synced farm!), WIKI_SEMINDEX_SCAN_MS, WIKI_SEMINDEX_SETTLE_MS,
// WIKI_SEMINDEX_THROTTLE_MS, WIKI_SEMINDEX_IDLE_MS, WIKI_SEMINDEX_MIN_PAGES,
// WIKI_SEMINDEX_MAINTENANCE, WIKI_MODEL_CACHE, WIKI_EMBED_FORCE_WASM,
// WIKI_EMBED_QUANTIZED.
//
// CommonJS on purpose (see sibling server/package.json): older wiki-server
// require() loaders swallow ERR_REQUIRE_ESM and silently drop these routes.

const indexer  = require('./indexer')
const embedLib = require('./embed-lib')

const PLUGIN_VERSION = (() => {
  try { return require('../package.json').version } catch { return 'unknown' }
})()

// Small per-IP token bucket for the public embed route.
const buckets = new Map()
const takeToken = ip => {
  const now = Date.now()
  let b = buckets.get(ip)
  if (!b) { b = { tokens: 30, at: now }; buckets.set(ip, b) }
  b.tokens = Math.min(30, b.tokens + (now - b.at) / 1000) // refill 1/s
  b.at = now
  if (buckets.size > 1000) buckets.clear() // crude memory cap
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

const requestIp = req =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket.remoteAddress || 'unknown'

// POST bodies are read off the stream: the wiki app mounts no JSON middleware
// we can rely on. Same helper as wiki-plugin-similarity's server.
const readBody = req =>
  new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body)
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) }
      catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)) }
    })
    req.on('error', reject)
  })

const startServer = ({ argv, app }) => {
  // One scheduler per process — init() self-guards across per-site instances.
  indexer.init(argv)

  const cors = res => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }

  for (const route of ['/system/semindex-status.json', '/system/semindex-build.json',
                       '/system/semindex-embed.json']) {
    app.options(route, (req, res) => { cors(res); res.sendStatus(204) })
  }

  // Owner/admin gate. Under the default (read-only) security module both
  // checks return false for everyone, so build triggers are inert — correct
  // for an unowned wiki, where only the background scan indexes.
  const authorized = req => {
    const sh = app.securityhandler
    try { return !!sh && (!!sh.isAdmin?.(req) || !!sh.isAuthorized?.(req)) } catch { return false }
  }

  app.get('/system/semindex-status.json', (req, res) => {
    cors(res)
    res.json({ version: PLUGIN_VERSION, ...indexer.status() })
  })

  const buildHandler = (req, res) => {
    cors(res)
    if (!authorized(req)) return res.sendStatus(403)
    if (indexer.MODE !== 'writer') {
      return res.status(409).json({ error: `semindex mode is '${indexer.MODE}' — not a writer` })
    }
    const domains = req.query.domains || (req.body && req.body.domains) || '*'
    const force = req.query.force === '1' || (req.body && req.body.force) === true
    const queued = indexer.enqueueGlobs(domains, force)
    res.json({ queued, ...indexer.status() })
  }
  app.get('/system/semindex-build.json', buildHandler)
  app.post('/system/semindex-build.json', buildHandler)

  // GET ?text=… suits short queries; POST {text} carries whole-page prose —
  // long text in a GET query string overflows Node's header limit and dies
  // with 431 before any handler runs. One handler, both verbs (the house
  // dual-verb pattern used by semindex-build.json above).
  //
  // POST also makes this the endpoint a remote slim similarity can point
  // WIKI_EMBED_URL at: that client POSTs {text} and reads .vector. Unlike
  // similarity's own /system/embed.json this route is rate-limited, which is
  // what a public name needs (Search Tool Plan, Phase 2).
  const embedHandler = async (req, res) => {
    cors(res)
    if (!takeToken(requestIp(req))) return res.sendStatus(429)
    let text = req.query.text || req.query.q
    if (!text && req.method === 'POST') {
      try { text = (await readBody(req)).text } catch { /* fall through to 400 */ }
    }
    if (!text) return res.status(400).json({ error: 'text parameter required' })
    try {
      const vector = await embedLib.embed(text)
      res.json({ vector, ...embedLib.MODEL_META })
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) })
    }
  }
  app.get('/system/semindex-embed.json', embedHandler)
  app.post('/system/semindex-embed.json', embedHandler)
}

module.exports = { startServer }
