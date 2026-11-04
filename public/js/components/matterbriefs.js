import { api } from '/js/api.js';
import { html, useState, useEffect, Field, emitToast } from '/js/ui.js';
import { CmPicker } from '/js/components/cmpicker.js';
const sections = [['overview','Matter'],['documents','Documents'],['people','People'],['current_status','Latest recorded status'],['open_issues','Open issues'],['recent_developments','Recent developments'],['uncertainties','Uncertainty']];
export function MatterBriefsCard({settings,reloadSettings}){
 const [status,setStatus]=useState(null),[matter,setMatter]=useState(null),[current,setCurrent]=useState(null),[versions,setVersions]=useState([]),[shown,setShown]=useState(null),[evidence,setEvidence]=useState([]),[error,setError]=useState(''),[models,setModels]=useState([]);
 const cfg=settings.matterBriefs||{enabled:false,model:'qwen3.6-35b:latest',hour:2};
 const running=status?.runs?.find(r=>r.status==='running');
 async function reload(){try{setStatus(await api.get('/api/matter-briefs'));setError('');}catch(e){setError(e.message);}}
 async function loadMatter(id){const [r,v]=await Promise.all([api.get(`/api/matter-briefs/${id}`),api.get(`/api/matter-briefs/${id}/versions`)]);return {r,v};}
 useEffect(()=>{reload();api.get('/api/ai/status').then(r=>setModels(r.models||[])).catch(()=>{});const timer=setInterval(reload,5000);return ()=>clearInterval(timer);},[]);
 useEffect(()=>{let active=true;setCurrent(null);setShown(null);setEvidence([]);setVersions([]);if(matter)loadMatter(matter.id).then(({r,v})=>{if(active){setCurrent(r);setShown(r.brief);setVersions(v.versions);}}).catch(e=>active&&setError(e.message));return ()=>{active=false};},[matter?.id,status?.runs?.[0]?.finished_at]);
 async function save(value){await api.patch('/api/settings',{matterBriefs:value});await reloadSettings();await reload();}
 async function run(mode){try{await api.post('/api/matter-briefs/run',{mode,...(mode==='matter'?{matter_id:matter.id}:{})});await reload();emitToast('Matter brief update started.');}catch(e){setError(e.message);}}
 const latest=status?.runs?.[0];
 return html`<div class="card" data-matter-briefs>
  <h2>Running matter briefs</h2>
  <p class="muted small">A stronger local model maintains context from finalized billable entries. The initial pass covers matters billed in the last 30 days and reads their finalized history. Nightly updates incorporate new work and status. Inferred context is labeled; every claim links to its billing sources.</p>
  <label class="checkbox-row"><input type="checkbox" checked=${!!cfg.enabled} onChange=${e=>save({enabled:e.target.checked})} />Update briefs nightly</label>
  <div class="row">
   <${Field} label="Brief model"><select value=${cfg.model} onChange=${e=>save({model:e.target.value})}>${[...new Set([cfg.model,...models])].map(m=>html`<option key=${m} value=${m}>${m}</option>`)}</select><//>
   <${Field} label="Nightly hour (server local time)"><input type="number" min="0" max="23" value=${cfg.hour} onChange=${e=>save({hour:Number(e.target.value)})} /><//>
  </div>
  <p class="small">${status?.count??0} stored briefs.${running?` Updating ${running.updated+running.skipped+running.errors.length} of ${running.total} matters.`:latest?` Last pass: ${latest.status}; ${latest.updated} updated, ${latest.skipped} unchanged, ${latest.errors.length} errors.`:''}</p>
  <button class="btn btn-sm" disabled=${!!running} onClick=${()=>run('initial')}>Update matters billed in last 30 days</button>
  ${error?html`<p role="alert">${error}</p>`:null}
  ${latest?.errors?.length?html`<details><summary>Update errors (${latest.errors.length})</summary>${latest.errors.map((e,i)=>html`<p key=${i} class="small">${e.matter_id?`Matter ${e.matter_id}: `:''}${e.message}</p>`)}</details>`:null}
  <hr />
  <${Field} label="Review a matter brief"><${CmPicker} value=${matter} onChange=${setMatter} allowCreate=${false} placeholder="Choose a matter" /><//>
  ${matter?html`<button class="btn btn-sm" disabled=${!!running} onClick=${()=>run('matter')}>Update this matter</button>`:null}
  ${matter&&current&&!current.brief?html`<p class="muted small">No brief yet. Update this matter to build one.</p>`:null}
  ${shown?html`<div>
   <p class="muted small">Through ${shown.through_date} · ${shown.model} · updated ${new Date(shown.updated_at).toLocaleString()}${current&&!current.usable?' · Source changes require a refresh before use.':''}</p>
   <label>Version <select value=${shown.version} onChange=${async e=>{const v=Number(e.target.value);setEvidence([]);setShown(v===current.brief.version?current.brief:await api.get(`/api/matter-briefs/${matter.id}/versions/${v}`));}}>${versions.map(v=>html`<option key=${v.version} value=${v.version}>${v.version} · ${v.through_date}</option>`)}</select></label>
   ${sections.filter(([k])=>shown.brief[k].length).map(([key,title])=>html`<section key=${key}><h3>${title}</h3><ul>${shown.brief[key].map((c,i)=>html`<li key=${i}>${c.kind==='inferred'?html`<span class="muted small">Inferred: </span>`:null}${c.text}${['current_status','open_issues','recent_developments'].includes(key)?html` <span class="muted small">(last cited ${shown.sources.filter(s=>c.source_entry_ids.includes(s.id)).map(s=>s.date).sort().at(-1)})</span>`:null} <button class="btn btn-ghost btn-sm" onClick=${()=>setEvidence(c.source_entry_ids)}>Sources ${c.source_entry_ids.join(', ')}</button></li>`)}</ul></section>`)}
   ${evidence.length?html`<section><h3>Billing sources</h3>${shown.sources.filter(s=>evidence.includes(s.id)).map(s=>html`<p key=${s.id}><strong>${s.date} · Entry ${s.id}</strong><br />${s.narrative}</p>`)}</section>`:null}
  </div>`:null}
 </div>`;
}
