// wiki-plugin-semindex — embedding child process (CommonJS, fork()ed by embed-lib)
//
// Hosts the transformers.js pipeline in its own PROCESS so ONNX inference can
// neither block the wiki's event loop nor kill the wiki when the runtime hits
// a fatal error (abort, OOM, bad model file). Until 0.2.0 this was a worker
// thread, which isolates neither native aborts nor out-of-memory kills — the
// failure mode behind the 2026-07-22 hitchhikers.earth farm outage (via the
// same runtime in wiki-plugin-similarity 0.8.x). Reproduces the farm's
// embedding exactly: BAAI/bge-small-en-v1.5, 384-dim, cls-pooled,
// L2-normalised, fp32, no instruction prefix.
//
// IPC protocol (parent → child, child → parent):
//   {id, text}            →  {id, vector: number[384]} | {id, error}
//   unsolicited progress  ←  {type: 'progress', file, pct}   (model download)
//   unsolicited ready     ←  {type: 'ready', backend}        (pipeline loaded)
//
// The onnxruntime-node native binary needs glibc; on musl containers
// (node:alpine — the public farm) the require throws, and we register a
// module hook redirecting onnxruntime-node → onnxruntime-web (WASM).
// WIKI_EMBED_FORCE_WASM=1 forces WASM.
//
// WIKI_EMBED_MOCK=1 skips the model and returns deterministic vectors — for
// tests, where a text of '__CRASH__' also simulates a hard crash so the
// parent's isolation and circuit breaker can be exercised.

const path = require('node:path')
const os = require('node:os')

const MODEL     = process.env.WIKI_EMBED_MODEL || 'Xenova/bge-small-en-v1.5'
const POOLING   = process.env.WIKI_EMBED_POOLING || 'cls'
const QUANTIZED = process.env.WIKI_EMBED_QUANTIZED === '1'
const MOCK      = process.env.WIKI_EMBED_MOCK === '1'

// Model cache must survive npm updates and stay out of Nextcloud-synced farm
// roots — default to a home cache dir, shared with wiki-plugin-similarity.
const CACHE_DIR = process.env.WIKI_MODEL_CACHE ||
  path.join(os.homedir(), '.cache', 'wiki-semindex')

const nativeOrtLoads = () => {
  if (process.env.WIKI_EMBED_FORCE_WASM === '1') return false
  try { require('onnxruntime-node'); return true } catch { return false }
}

let extractorPromise = null
let backend = 'native'

const getExtractor = () => {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      if (!nativeOrtLoads()) {
        backend = 'wasm'
        const { register } = require('node:module')
        if (typeof register !== 'function') {
          throw new Error('native onnxruntime unavailable and Node lacks ' +
            'module.register (need >= 18.19) for the WASM fallback')
        }
        register('./ort-hooks.mjs', require('node:url').pathToFileURL(__filename))
      }
      const { pipeline, env } = await import('@xenova/transformers')
      env.cacheDir = CACHE_DIR
      if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1
      const extractor = await pipeline('feature-extraction', MODEL, {
        quantized: QUANTIZED,
        progress_callback: p => {
          if (p && p.status === 'progress') {
            process.send({
              type: 'progress', file: p.file,
              pct: Math.round(p.progress || 0),
            })
          }
        },
      })
      process.send({ type: 'ready', backend })
      return extractor
    })()
    extractorPromise.catch(() => { extractorPromise = null }) // allow retry
  }
  return extractorPromise
}

// Deterministic unit vector from text — mock mode only.
const mockVector = text => {
  const crypto = require('node:crypto')
  const v = []
  let seed = crypto.createHash('sha256').update(text).digest()
  while (v.length < 384) {
    for (const byte of seed) v.push((byte - 127.5) / 127.5)
    seed = crypto.createHash('sha256').update(seed).digest()
  }
  const vec = v.slice(0, 384)
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0))
  return vec.map(x => x / norm)
}

process.on('message', async msg => {
  try {
    if (MOCK) {
      if (msg.text === '__CRASH__') process.exit(13) // simulated hard crash (tests)
      return process.send({ id: msg.id, vector: mockVector(msg.text) })
    }
    const extractor = await getExtractor()
    const out = await extractor(msg.text, { pooling: POOLING, normalize: true })
    process.send({ id: msg.id, vector: Array.from(out.data) })
  } catch (e) {
    try { process.send({ id: msg.id, error: String((e && e.message) || e) }) } catch { /* parent gone */ }
  }
})

// Parent died or closed the channel — no reason to linger.
process.on('disconnect', () => process.exit(0))
