import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {createApp} from '../server/app.mjs';
import {classifyIntent,emptyIntent,validateIntent} from '../server/acquisition/intent.mjs';

const env={ACQUISITION_AI_PROVIDER:'claude',ANTHROPIC_API_KEY:'test',ANTHROPIC_MODEL:'test'};
test('production intent is a validated model tool result, including contextual negation',async t=>{
 const original=globalThis.fetch; t.after(()=>globalThis.fetch=original);const requests=[];
 globalThis.fetch=async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({stop_reason:'tool_use',content:[{type:'tool_use',name:'assess_customer_intent',input:{...emptyIntent(),booking:'none',form:'decline'}}]})};};
 const result=await classifyIntent({env,text:'Please do not book another time or send the form; I only need directions.',messages:[],project:{stage:'meeting_booked',facts:{}},conversation:{}});
 assert.equal(result.booking,'none');assert.equal(result.form,'decline');assert.equal(result.human,'none');assert.equal(result.optOut,false);assert.equal(requests[0].tool_choice.name,'assess_customer_intent');assert.match(requests[0].messages[0].content,/only need directions/);
 assert.throws(()=>validateIntent({...emptyIntent(),booking:'delete_everything'}));
});

test('semantic reschedule routes an indirect request without relying on booking keywords',async t=>{
 const dir=mkdtempSync('/tmp/semantic-reschedule-'),original=globalThis.fetch;
 const app=createApp({dataDir:dir,seed:false,env,agent:{mode:'mock',async run(){throw new Error('The structured reschedule should route directly');}}});
 t.after(()=>{globalThis.fetch=original;app.close();rmSync(dir,{recursive:true,force:true});});const s=app.service,c=s.createContact({handle:'semantic.customer'});
 s.put('conversations',{...s.get('conversations',c.id),replyWindowUntil:new Date(Date.now()+86400000).toISOString()});
 const first=s.customerPages.create(c.id,'booking').url.split('#')[1],slots=await s.customerPages.slots(first);await s.customerPages.book(first,slots.slots[0].id);
 globalThis.fetch=async()=>({ok:true,json:async()=>({stop_reason:'tool_use',content:[{type:'tool_use',name:'assess_customer_intent',input:{...emptyIntent(),booking:'reschedule'}}]})});
 await s.receive({contactId:c.id,eventId:'indirect',text:'Tuesday is suddenly impossible for me — could we find a later opening instead?'});
 const message=s.list('messages').find(m=>m.direction==='outbound');assert.match(message.text,/current appointment stays/);assert.match(message.text,/customer#/);assert.equal(s.list('bookings').length,1);assert.equal(s.list('inbound_events')[0].intent.booking,'reschedule');
});

test('failed production assessment fails closed instead of falling back to keyword actions',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async()=>({ok:true,json:async()=>({stop_reason:'end_turn',content:[{type:'text',text:'book now'}]})});
 await assert.rejects(()=>classifyIntent({env,text:'Book another time',messages:[],project:{facts:{}},conversation:{}}),/No valid intent assessment/);
});

test('typed button labels do not bypass semantic understanding in live routing',async()=>{
 const {resolveQuickReply}=await import('../server/acquisition/quick-replies.mjs');
 const conversation={projectId:'project',ownershipVersion:1,messageVersion:2};
 const messages=[{direction:'outbound',status:'sent',replyToVersion:2,quickReplies:[{title:'Yes',payload:'opaque-choice',projectId:'project',ownershipVersion:1,action:{type:'consultation',value:'yes'}}]}];
 assert.equal(resolveQuickReply({text:'Yes',messages,conversation,config:{}}),null);
 assert.equal(resolveQuickReply({text:'Yes',payload:'opaque-choice',messages,conversation,config:{}}).type,'consultation');
 assert.equal(resolveQuickReply({text:'Yes',payload:'stale-choice',messages,conversation,config:{}}).invalid,true);
});
