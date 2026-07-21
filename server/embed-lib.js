// wiki-plugin-semindex — embedding facade (CommonJS)
//
// Promise API over the worker-thread embedder. This module is a process-wide
// singleton (require cache), shared by every farm site instance and — via
// require('wiki-plugin-semindex/server/embed-lib.js') — by other plugins
// (wiki-plugin-similarity delegates query embedding here when installed).
//
// The worker spawns on first use and is terminated after WIKI_SEMINDEX_IDLE_MS
// without traffic, returning the model's ~0.5GB RSS to the OS. A later embed
// pays a few seconds of model reload from disk cache.

const { Worker } = require('node:worker_threads')
const path = require('node:path')

const IDLE_MS = Math.max(60_000,
  parseInt(process.env.WIKI_SEMINDEX_IDLE_MS || '600000', 10) || 600_000)

const MODEL_META = {
  model: process.env.WIKI_EMBED_MODEL || 'BAAI/bge-small-en-v1.5',
  dim: 384,
  quantized: process.env.WIKI_EMBED_QUANTIZED === '1',
}

const state = {
  worker: null,
  pending: new Map(), // id -> {resolve, reject}
  nextId: 1,
  backend: null,      // 'native' | 'wasm' once known
  download: null,     // {file, pct} while the model downloads
  error: null,
  idleTimer: null,
}

const stopWorker = () => {
  if (state.worker) {
    state.worker.terminate()
    state.worker = null
  }
}

const bumpIdle = () => {
  clearTimeout(state.idleTimer)
  state.idleTimer = setTimeout(() => {
    if (!state.pending.size) stopWorker()
  }, IDLE_MS)
  if (state.idleTimer.unref) state.idleTimer.unref()
}

const getWorker = () => {
  if (!state.worker) {
    const w = new Worker(path.join(__dirname, 'embed-worker.js'))
    w.unref() // never keep the wiki process alive on our account
    w.on('message', msg => {
      if (msg.type === 'progress') { state.download = { file: msg.file, pct: msg.pct }; return }
      if (msg.type === 'ready')    { state.backend = msg.backend; state.download = null; state.error = null; return }
      const p = state.pending.get(msg.id)
      if (!p) return
      state.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error))
      else p.resolve(msg.vector)
      bumpIdle()
    })
    w.on('error', err => {
      state.error = String((err && err.message) || err)
      for (const p of state.pending.values()) p.reject(err)
      state.pending.clear()
      if (state.worker === w) state.worker = null
    })
    w.on('exit', () => { if (state.worker === w) state.worker = null })
    state.worker = w
  }
  return state.worker
}

// Embed one text → number[384], unit-normalised.
const embed = text =>
  new Promise((resolve, reject) => {
    const id = state.nextId++
    state.pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, text })
    bumpIdle()
  })

const status = () => ({
  loaded: !!state.worker,
  backend: state.backend,
  download: state.download,
  error: state.error,
  pending: state.pending.size,
})

module.exports = { embed, status, stop: stopWorker, MODEL_META }
