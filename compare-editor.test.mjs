import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stripCodeAnchors } from './code-block-toggle.mjs';
function harness({accepted=true,original='New source',translation='새 번역',stale=false,autoIn=false}={}) {
 const source=readFileSync(new URL('./index.js',import.meta.url),'utf8');
 const message={mes:'Old source',extra:{display_text:'옛 번역'},swipe_id:0,swipes:['Old source','Other swipe'],swipe_info:[{extra:{}},{extra:{}}]};
 let saves=0,discards=0,html=''; const translations=[];
 const ctx=vm.createContext({chat:[message],chat_metadata:{},stripCodeAnchors,structuredClone,
 $:s=>s==='<div>'?{text(t){this.value=t;return this},html(){return this.value}}:(html=s,{find:c=>({val:()=>c.endsWith('__orig')?original:translation})}),
 POPUP_TYPE:{CONFIRM:1},callGenericPopup:async()=>{if(stale)ctx.chat[0]={mes:'Another chat'};return accepted},
 discardMessageJobs:()=>discards++,getStringHash:s=>'hash:'+s,getSettings:()=>({enabled:true,autoIn}),translateIncoming:async(id,options)=>translations.push({id,options}),updateMessageBlock(){},getContext:()=>({saveChat:async()=>saves++})});
 vm.runInContext(source.slice(source.indexOf('async function openComparePopup('),source.indexOf('function collectScanMaterial(')),ctx);
 return {ctx,message,counts:()=>({saves,discards}),html:()=>html,translations};
}
test('compare editor saves both fields and current swipe only',async()=>{
 const h=harness();await h.ctx.openComparePopup(0);
 assert.equal(h.message.mes,'New source');assert.equal(h.message.extra.display_text,'새 번역');
 assert.equal(h.message.extra.interpres_codeblocks_src,'hash:New source');
 assert.deepEqual(h.message.swipes,['New source','Other swipe']);
 assert.deepEqual(h.message.swipe_info[0].extra,h.message.extra);
 assert.deepEqual(h.counts(),{saves:1,discards:1});
 assert.ok(!h.html().includes('readonly'));assert.ok(!h.html().includes('직접 수정 가능'));
});
test('closing compare editor saves neither field',async()=>{
 const h=harness({accepted:false});await h.ctx.openComparePopup(0);
 assert.equal(h.message.mes,'Old source');assert.equal(h.message.extra.display_text,'옛 번역');assert.deepEqual(h.counts(),{saves:0,discards:0});
});
test('clearing translation exposes edited source and stamps it to prevent unwanted auto-retranslation',async()=>{
 const h=harness({translation:''});await h.ctx.openComparePopup(0);
 assert.equal(h.message.mes,'New source');assert.equal(h.message.extra.display_text,undefined);assert.equal(h.message.extra.interpres_codeblocks_original,true);assert.equal(h.message.extra.interpres_codeblocks_src,'hash:New source');
});
test('chat switch while compare editor is open cannot save into old or new chat',async()=>{
 const h=harness({stale:true});await h.ctx.openComparePopup(0);
 assert.equal(h.message.mes,'Old source');assert.deepEqual(h.counts(),{saves:0,discards:0});
});

test('editing original with auto translation enabled requests only an incremental translation',async()=>{
 const h=harness({autoIn:true});await h.ctx.openComparePopup(0);
 assert.equal(h.translations.length,1);assert.equal(h.translations[0].options.force,true);
 assert.equal(h.translations[0].options.previous.source,'Old source');
 assert.equal(h.translations[0].options.previous.translated,'새 번역');
});
test('editing translation alone never triggers another API translation',async()=>{
 const h=harness({autoIn:true,original:'Old source'});await h.ctx.openComparePopup(0);
 assert.equal(h.translations.length,0);
});
