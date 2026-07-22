import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Exercises the real child-process supervisor (server/embed-lib.js) with the
// child in mock mode: no model download, deterministic vectors, and a
// '__CRASH__' text that makes the child hard-exit — proving the crash is an
// event in the parent, not a parent death. Env must be set before the module
// loads its config, hence the dynamic import.

process.env.WIKI_EMBED_MOCK = '1'
process.env.WIKI_SEMINDEX_TIMEOUT_MS = '10000'
process.env.WIKI_EMBED_MAX_CRASHES = '3'
process.env.WIKI_EMBED_CRASH_WINDOW_MS = '60000'
process.env.WIKI_EMBED_COOLDOWN_MS = '60000'

const embedLib = (await import('../server/embed-lib.js')).default

describe('child-process embed-lib', () => {
  it('embeds via the child and returns a unit vector', async () => {
    const vector = await embedLib.embed('hello federation')
    assert.equal(vector.length, 384)
    const norm = Math.sqrt(vector.reduce((s, x) => s + x * x, 0))
    assert.ok(Math.abs(norm - 1) < 1e-6, `expected unit norm, got ${norm}`)
    // deterministic in mock mode
    assert.deepEqual(await embedLib.embed('hello federation'), vector)
    const status = embedLib.status()
    assert.equal(status.isolation, 'child-process')
    assert.equal(status.loaded, true)
  })

  it('does not count a deliberate stop as a crash', async () => {
    await embedLib.embed('warm the child')
    embedLib.stop()
    await new Promise(r => setTimeout(r, 200)) // let the exit event land
    assert.equal(embedLib.status().recentCrashes, 0)
    // and it respawns on demand
    assert.equal((await embedLib.embed('respawned')).length, 384)
  })

  it('survives a child crash and recovers on the next call', async () => {
    await assert.rejects(embedLib.embed('__CRASH__'), /exited/)
    const vector = await embedLib.embed('still alive')
    assert.equal(vector.length, 384)
    assert.equal(embedLib.status().recentCrashes, 1)
  })

  it('opens the breaker after repeated crashes and fails fast', async () => {
    await assert.rejects(embedLib.embed('__CRASH__'), /exited/)
    await assert.rejects(embedLib.embed('__CRASH__'), /exited/)
    // three crashes inside the window → breaker open
    assert.ok(embedLib.status().breakerOpenUntil, 'breaker should be open')
    await assert.rejects(embedLib.embed('anything'), err => {
      assert.equal(err.code, 'EMBEDDER_DOWN')
      assert.match(err.message, /temporarily unavailable/)
      return true
    })
  })
})
