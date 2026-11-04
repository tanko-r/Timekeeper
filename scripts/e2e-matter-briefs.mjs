// Browser check with a fake brief model; never calls a real LLM or production DB.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startTestServer } from '../test/helpers.js';
import { BRIEF_SECTIONS } from '../server/lib/matterBriefs.js';
const t=await startTestServer({clock:()=>new Date('2026-11-04T10:00:00-08:00'),deps:{briefGenerate:async input=>({...Object.fromEntries(BRIEF_SECTIONS.map(k=>[k,[]])),overview:[{text:'Cedar access agreement negotiation.',kind:'inferred',source_entry_ids:[input.sources[0].id]}]})}});
const cm=await t.fetchJson('POST','/api/cms',{cm_number:'100001-000001',short_name:'Cedar access'});
t.db.prepare("INSERT INTO entries(cm_id,date,narrative,status) VALUES(?,'2026-11-03','Review Cedar access agreement.','finalized')").run(cm.body.id);
const browser=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(t.base+'/#/settings/ai');await page.waitForSelector('[data-matter-briefs]');
 await page.evaluate(()=>{const card=document.querySelector('[data-matter-briefs]');[...card.querySelectorAll('button')].find(b=>b.textContent.includes('last 30 days')).click();});
 await page.waitForFunction(()=>document.querySelector('[data-matter-briefs]').textContent.includes('1 stored briefs'));
 // Use the card's matter search, whose class is shared with the existing picker.
 const input=await page.$('[data-matter-briefs] input[placeholder="Choose a matter"]');assert.ok(input);await input.click();await input.type('Cedar');
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-matter-briefs] .cmpicker-item')].some(b=>b.textContent.includes('Cedar access')));
 await page.click('[data-matter-briefs] .cmpicker-item');
 await page.waitForFunction(()=>document.querySelector('[data-matter-briefs]').textContent.includes('Cedar access agreement negotiation.'));
 await page.evaluate(()=>[...document.querySelectorAll('[data-matter-briefs] button')].find(b=>b.textContent.includes('Sources')).click());
 await page.waitForFunction(()=>document.querySelector('[data-matter-briefs]').textContent.includes('Review Cedar access agreement.'));
 assert.deepEqual(errors,[]);console.log('MATTER BRIEF UI: initial update, matter selection, inferred context and billing source review passed.');
}finally{await browser.close();await t.close();}
