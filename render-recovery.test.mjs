import test from 'node:test';
import assert from 'node:assert/strict';
import { isFrontendText, rendererListeners, RenderRecovery } from './render-recovery.mjs';
const events={CHARACTER_MESSAGE_RENDERED:'ai',USER_MESSAGE_RENDERED:'user'};
// Same callback shape as TH's published message_iframe_runtimes store/bundle.
function rendererFixture(render) {
 const global_settings={settings:{render:{enabled:true,depth:30,depth_ignore_hidden:false}}};
 const runtimes={value:[{message_id:0}]};const _={reject:(items,fn)=>items.filter(item=>!fn(item))};
 function auditRuntimes(items){render();return items;}
 return message_id=>{
  if(global_settings.settings.render.enabled){
   const numbered_message_id=Number(message_id);
   runtimes.value=auditRuntimes(_.reject(runtimes.value,runtime=>runtime.message_id===numbered_message_id),global_settings.settings.render.depth,global_settings.settings.render.depth_ignore_hidden);
  }
 };
}
function harness({working=true,generating=false}={}){
 let repaired=0,sideEffects=0;const errors=[];let broken=true;let destroyed=false;let clock=0;
 const message={mes:'```html\n<body>Hello</body>\n```',extra:{display_text:'```html\n<body>안녕</body>\n```'}};
 const code={textContent:'<body>안녕</body>'};
 const pre={closest:()=>null,querySelector:()=>code};
 const element={getAttribute:()=> '0',querySelector:()=>({textContent:'안녕'}),querySelectorAll:s=>s.endsWith('pre')?(broken?[pre]:[]):[]};
 const root={scrollTop:12,scrollHeight:500,clientHeight:100,querySelector:()=>element,querySelectorAll:()=>[element]};
 const render=rendererFixture(()=>{repaired++;if(working)broken=false;});
 const eventSource={events:{ai:[()=>sideEffects++,render],user:[render]},emit(){throw Error('Never broadcast events');}};
 const ctx={chat:[message],eventSource};let chatId='one';
 class Observer{observe(){}disconnect(){destroyed=true;}}
 const guard=new RenderRecovery({root,getContext:()=>ctx,getChatId:()=>chatId,enabled:()=>true,isGenerating:()=>generating,events,Observer,delay:100000,deadDelay:100000,now:()=>clock,onError:e=>errors.push(e)});
 return {guard,root,element,ctx,counts:()=>({repaired,sideEffects}),errors,
 setGenerating:v=>generating=v,setChat:id=>chatId=id,setBroken:v=>broken=v,setClock:v=>clock=v,destroyed:()=>destroyed};
}
test('only HTML frontends, not ordinary source code, are recovery targets',()=>{
 assert.equal(isFrontendText('<BODY class="panel">'),true);
 assert.equal(isFrontendText('const greeting = "Hello";'),false);
});
test('adapter accepts the verified TH callback and rejects translator/QR/TTS handlers',()=>{
 const h=harness();try{assert.deepEqual(rendererListeners(h.ctx,'ai'),[h.ctx.eventSource.events.ai[1]]);assert.deepEqual(rendererListeners({eventSource:{events:{ai:{}}}},'ai'),[]);}finally{h.guard.destroy();}
});
test('automatic repair leaves translation/source and settings untouched and invokes no other listeners',async()=>{
 const h=harness();const original=JSON.stringify(h.ctx.chat);try{
  await h.guard.scan();assert.deepEqual(h.counts(),{repaired:1,sideEffects:0});
  assert.equal(JSON.stringify(h.ctx.chat),original);assert.equal(h.root.scrollTop,12);
  await h.guard.scan();assert.equal(h.counts().repaired,1);
 }finally{h.guard.destroy();}
});
test('broken content has three attempts at most; changing source resets the limit',async()=>{
 const h=harness({working:false});try{
  for(let i=0;i<8;i++){h.guard.queue(h.element);await h.guard.scan();}
  assert.equal(h.counts().repaired,3);
  h.ctx.chat[0].mes+='New contents';h.guard.queue(h.element);await h.guard.scan();assert.equal(h.counts().repaired,4);
 }finally{h.guard.destroy();}
});
test('streaming waits, then repair resumes after generation',async()=>{
 const h=harness({generating:true});try{await h.guard.scan();assert.equal(h.counts().repaired,0);h.setGenerating(false);await h.guard.scan();assert.equal(h.counts().repaired,1);}finally{h.guard.destroy();}
});
test('unsupported renderer does not fall back to broadcasting potentially paid events',async()=>{
 const h=harness();h.ctx.eventSource.events.ai.shift();h.ctx.eventSource.events.ai=[];try{await h.guard.scan();assert.equal(h.errors.length,1);assert.equal(h.counts().repaired,0);}finally{h.guard.destroy();}
});
test('empty iframe wrappers receive a grace period; hidden wrappers are not height failures',()=>{
 const h=harness();try{
  h.setBroken(false);const wrapper={querySelector:()=>null};
  h.element.querySelectorAll=s=>s.endsWith('pre')?[]:[wrapper];
  assert.equal(h.guard.broken(h.element,0),false);h.setClock(100001);assert.equal(h.guard.broken(h.element,0),true);
  wrapper.querySelector=()=>({getBoundingClientRect:()=>({height:0})});wrapper.getClientRects=()=>[];
  assert.equal(h.guard.broken(h.element,0),false);
 }finally{h.guard.destroy();}
});
test('destroy disconnects observer and cancels queued work; chat reset clears retries',async()=>{
 const h=harness({working:false});await h.guard.scan();h.setChat('two');h.guard.reset();assert.equal(h.guard.attempts.size,0);h.guard.destroy();await h.guard.scan();assert.equal(h.counts().repaired,1);assert.equal(h.destroyed(),true);
});
