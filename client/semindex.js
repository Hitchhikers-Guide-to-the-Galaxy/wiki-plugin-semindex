/* wiki-plugin-semindex - 0.2.2 - Fri, 07 Aug 2026 20:28:50 GMT */
(()=>{var d=t=>String(t??"").replace(/[&<>"]/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[e]),u=t=>{let e=Math.round((Date.now()-t)/1e3);return e<90?`${e}s ago`:e<5400?`${Math.round(e/60)}m ago`:`${Math.round(e/3600)}h ago`},m=(t,e)=>{let s=e.embedder&&e.embedder.download,n=e.building,c=`state <b>${d(e.state)}</b> \xB7 mode ${d(e.mode)}`;e.embedder&&e.embedder.backend&&(c+=` \xB7 ${d(e.embedder.backend)}`);let o="";if(s)o=`<div>downloading model ${d(s.file||"")} ${s.pct||0}%</div>
      <div class="semindex-bar"><div style="width:${s.pct||0}%"></div></div>`;else if(n){let i=n.total?Math.round(n.done/n.total*100):0;o=`<div>indexing <b>${d(n.domain)}</b> \u2014 ${n.done} / ${n.total} pages</div>
      <div class="semindex-bar"><div style="width:${i}%"></div></div>`}let a=(e.queue||[]).length?`<div>queued: ${e.queue.map(d).join(", ")}</div>`:"",l=Object.entries(e.lastBuild||{}).sort((i,r)=>(r[1].at||0)-(i[1].at||0)).slice(0,5).map(([i,r])=>r.error?`<div>\u26A0 ${d(i)} \u2014 ${d(r.error)}</div>`:`<div>\u2713 ${d(i)} \u2014 ${r.embedded}/${r.pages} pages, ${u(r.at)}</div>`).join("");t.innerHTML=`
    <div style="font-size:80%; line-height:1.5">
      <div>${c} \xB7 ${d(e.model||"")}</div>
      ${o}${a}${l}
      <div style="margin-top:4px">
        <button class="semindex-build">Build stale sites</button>
        <span class="semindex-msg"></span>
      </div>
    </div>
    <style>
      .semindex-bar { height: 6px; background: #eee; border-radius: 3px; margin: 2px 0 }
      .semindex-bar div { height: 100%; background: #4a90d9; border-radius: 3px }
    </style>`},g=(t,e)=>{t.html('<div class="semindex">semindex: loading status\u2026</div>')},b=(t,e)=>{let s=t.find(".semindex")[0];if(!s)return;let n=async()=>{if(!document.contains(s)){clearInterval(c);return}try{let o=await fetch("/system/semindex-status.json").then(a=>a.json());m(s,o)}catch(o){s.textContent=`semindex: status unavailable (${o})`}},c=setInterval(n,5e3);n(),t.on("click",".semindex-build",async o=>{o.stopPropagation();let a=t.find(".semindex-msg")[0];try{let l=await fetch("/system/semindex-build.json?domains=*",{method:"POST"});if(l.status===403){a.textContent="owner only";return}let i=await l.json();a.textContent=i.queued&&i.queued.length?`queued ${i.queued.length} site(s)`:i.error||"nothing stale",n()}catch(l){a.textContent=String(l)}})};typeof window<"u"&&(window.plugins=window.plugins||{},window.plugins.semindex={emit:g,bind:b});})();
//# sourceMappingURL=semindex.js.map
