import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stripCodeAnchors } from './code-block-toggle.mjs';
const source=readFileSync(new URL('./index.js',import.meta.url),'utf8');
function harness() {
 const settings={translateCodeBlocks:true,sealMacros:true,sealTags:'',cacheEnabled:false};
 const store={blocks:{},wholes:{}};const calls=[];
 const ctx=vm.createContext({getSettings:()=>settings,getStringHash:s=>s,stripCodeAnchors,
 migrateCacheKeys(){},currentChatId:()=>1,getStore:()=>store,settingsFingerprint:()=>1,
 collectContextLines:()=>[],buildSystemPrompt:()=>'',bumpStats(){},persistStore(){},pruneStore(){},
 mapTranslationParts:async(items,fn)=>Promise.all(items.map(fn)),
 llmTranslate:async(_sys,text)=>{calls.push(text);return text.replaceAll('Changed','변경됨').replaceAll('New','새로움')},
 });
 vm.runInContext(source.slice(source.indexOf('const SEAL_RX ='),source.indexOf('const TONE_DIAL_LINES =')),ctx);
 vm.runInContext(source.slice(source.indexOf('function cacheKey('),source.indexOf('/** 직전 턴들의')),ctx);
 vm.runInContext(source.slice(source.indexOf('async function translateText('),source.indexOf('function validateRendering(')),ctx);
 return {ctx,calls};
}
test('one edited paragraph sends one request even for a two-paragraph message with cache disabled',async()=>{
 const h=harness();
 const result=await h.ctx.translateText('Unchanged\n\nChanged','en','ko',{previous:{source:'Unchanged\n\nOld',translated:'수동으로 손본 번역\n\n옛 번역'}});
 assert.equal(result,'수동으로 손본 번역\n\n변경됨');assert.deepEqual(h.calls,['Changed']);
});
test('inserted paragraph preserves following translated prose when protected seal numbers shift',async()=>{
 const h=harness();
 const result=await h.ctx.translateText('New {{user}}\n\nSame {{char}}','en','ko',{previous:{source:'Same {{char}}',translated:'기존 번역 {{char}}'}});
 assert.equal(result,'새로움 {{user}}\n\n기존 번역 {{char}}');assert.equal(h.calls.length,1);assert.ok(h.calls[0].startsWith('New'));
});
test('deleted paragraph requires no API call for surviving translated paragraphs',async()=>{
 const h=harness();const result=await h.ctx.translateText('Same','en','ko',{previous:{source:'Removed\n\nSame',translated:'삭제될 번역\n\n유지할 번역'}});
 assert.equal(result,'유지할 번역');assert.equal(h.calls.length,0);
});
