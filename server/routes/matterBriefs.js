import { Router } from 'express';
import { getSetting } from '../db.js';
import { startMatterBriefPass, getMatterBrief, briefPromptContext } from '../lib/matterBriefs.js';
import { todayLocal } from '../lib/dates.js';
export function matterBriefsRouter(deps){
 const {db,clock}=deps;const r=Router();
 r.get('/',(req,res)=>res.json({
  settings:getSetting(db,'matterBriefs'),state:getSetting(db,'matterBriefsState')||{},
  count:db.prepare('SELECT count(*) n FROM matter_briefs').get().n,
  runs:db.prepare('SELECT * FROM matter_brief_runs ORDER BY id DESC LIMIT 12').all().map(x=>({...x,errors:JSON.parse(x.errors_json),errors_json:undefined}))
 }));
 r.get('/:id',(req,res)=>{
  if(!db.prepare('SELECT id FROM matters WHERE id=?').get(req.params.id))return res.status(404).json({error:'Matter not found.'});
  const brief=getMatterBrief(db,req.params.id);
  res.json({matter_id:Number(req.params.id),brief,usable:!!briefPromptContext(db,req.params.id,todayLocal(clock()))});
 });
 r.get('/:id/versions',(req,res)=>{
  const versions=db.prepare('SELECT version,model,through_date,updated_at,source_hash FROM matter_brief_versions WHERE matter_id=? ORDER BY version DESC LIMIT 50').all(req.params.id);res.json({versions});
 });
 r.get('/:id/versions/:version',(req,res)=>{
  const row=db.prepare('SELECT * FROM matter_brief_versions WHERE matter_id=? AND version=?').get(req.params.id,req.params.version);
  if(!row)return res.status(404).json({error:'Brief version not found.'});
  res.json({...row,brief:JSON.parse(row.brief_json),sources:JSON.parse(row.sources_json),identity:JSON.parse(row.identity_json),brief_json:undefined,sources_json:undefined,identity_json:undefined});
 });
 r.post('/run',(req,res)=>{
  const b=req.body||{};if(!['initial','matter'].includes(b.mode))return res.status(400).json({error:'Choose initial or matter mode.'});
  try{
   const task=startMatterBriefPass(deps,{mode:b.mode,...(b.mode==='matter'?{matterId:Number(b.matter_id)}:{})});
   if(!task)return res.status(409).json({error:'A matter brief pass is already running.'});
   task.promise.catch(e=>console.error('matter brief pass failed:',e.message));
   res.status(202).json({run_id:task.run_id});
  }catch(e){res.status(400).json({error:e.message});}
 });
 return r;
}
