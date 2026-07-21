// wiki-plugin-semindex — client widget
//
// Shows the farm's semantic-index build status (polled from
// /system/semindex-status.json) with a progress bar during builds and a
// Build button (server enforces owner/admin — anonymous clicks get a 403).

const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const fmtAgo = ms => {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

const render = (el, st) => {
  const dl = st.embedder && st.embedder.download
  const b = st.building
  let stateLine = `state <b>${esc(st.state)}</b> · mode ${esc(st.mode)}`
  if (st.embedder && st.embedder.backend) stateLine += ` · ${esc(st.embedder.backend)}`

  let progress = ''
  if (dl) {
    progress = `<div>downloading model ${esc(dl.file || '')} ${dl.pct || 0}%</div>
      <div class="semindex-bar"><div style="width:${dl.pct || 0}%"></div></div>`
  } else if (b) {
    const pct = b.total ? Math.round((b.done / b.total) * 100) : 0
    progress = `<div>indexing <b>${esc(b.domain)}</b> — ${b.done} / ${b.total} pages</div>
      <div class="semindex-bar"><div style="width:${pct}%"></div></div>`
  }

  const queue = (st.queue || []).length
    ? `<div>queued: ${st.queue.map(esc).join(', ')}</div>` : ''

  const recent = Object.entries(st.lastBuild || {})
    .sort((a, z) => (z[1].at || 0) - (a[1].at || 0)).slice(0, 5)
    .map(([domain, r]) => r.error
      ? `<div>⚠ ${esc(domain)} — ${esc(r.error)}</div>`
      : `<div>✓ ${esc(domain)} — ${r.embedded}/${r.pages} pages, ${fmtAgo(r.at)}</div>`)
    .join('')

  el.innerHTML = `
    <div style="font-size:80%; line-height:1.5">
      <div>${stateLine} · ${esc(st.model || '')}</div>
      ${progress}${queue}${recent}
      <div style="margin-top:4px">
        <button class="semindex-build">Build stale sites</button>
        <span class="semindex-msg"></span>
      </div>
    </div>
    <style>
      .semindex-bar { height: 6px; background: #eee; border-radius: 3px; margin: 2px 0 }
      .semindex-bar div { height: 100%; background: #4a90d9; border-radius: 3px }
    </style>`
}

export const emit = (div, item) => {
  div.html('<div class="semindex">semindex: loading status…</div>')
}

export const bind = (div, item) => {
  const el = div.find('.semindex')[0]
  if (!el) return

  const tick = async () => {
    // fedwiki has no plugin dispose hook — self-teardown when detached
    if (!document.contains(el)) { clearInterval(timer); return }
    try {
      const st = await fetch('/system/semindex-status.json').then(r => r.json())
      render(el, st)
    } catch (e) {
      el.textContent = `semindex: status unavailable (${e})`
    }
  }
  const timer = setInterval(tick, 5000)
  tick()

  div.on('click', '.semindex-build', async e => {
    e.stopPropagation()
    const msg = div.find('.semindex-msg')[0]
    try {
      const res = await fetch('/system/semindex-build.json?domains=*', { method: 'POST' })
      if (res.status === 403) { msg.textContent = 'owner only'; return }
      const body = await res.json()
      msg.textContent = body.queued && body.queued.length
        ? `queued ${body.queued.length} site(s)` : (body.error || 'nothing stale')
      tick()
    } catch (err) {
      msg.textContent = String(err)
    }
  })
}

if (typeof window !== 'undefined') {
  window.plugins = window.plugins || {}
  window.plugins['semindex'] = { emit, bind }
}
