// wiki-plugin-semindex — embedding worker (CommonJS, runs in a worker_thread)
//
// Hosts the transformers.js pipeline so ONNX inference never blocks the wiki's
// event loop. Reproduces the farm's embedding exactly: BAAI/bge-small-en-v1.5,
// 384-dim, cls-pooled, L2-normalised, fp32, no instruction prefix.
//
// The onnxruntime-node native binary needs glibc; on musl containers
// (node:alpine — the public farm) the require throws, and we register a
// module hook redirecting onnxruntime-node → onnxruntime-web (WASM).
// module.register is PER-THREAD, which is why the probe+register lives here
// in the worker, not in the parent. WIKI_EMBED_FORCE_WASM=1 forces WASM.

const { parentPort } = require('node:worker_threads')
const path = require('node:path')
const os = require('node:os')

const MODEL     = process.env.WIKI_EMBED_MODEL || 'Xenova/bge-small-en-v1.5'
const POOLING   = process.env.WIKI_EMBED_POOLING || 'cls'
const QUANTIZED = process.env.WIKI_EMBED_QUANTIZED === '1'

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
            parentPort.postMessage({
              type: 'progress', file: p.file,
              pct: Math.round(p.progress || 0),
            })
          }
        },
      })
      parentPort.postMessage({ type: 'ready', backend })
      return extractor
    })()
    extractorPromise.catch(() => { extractorPromise = null }) // allow retry
  }
  return extractorPromise
}

parentPort.on('message', async msg => {
  try {
    const extractor = await getExtractor()
    const out = await extractor(msg.text, { pooling: POOLING, normalize: true })
    parentPort.postMessage({ id: msg.id, vector: Array.from(out.data) })
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: String((e && e.message) || e) })
  }
})
