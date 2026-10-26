import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { createConfig } from '../server/acquisition/config.mjs';
import { createProviders } from '../server/acquisition/providers.mjs';
import { summarizeFunnel } from '../server/acquisition/policy.mjs';
import { createStore } from '../server/store.mjs';
import { inject } from './http-harness.mjs';

function fixture(t, options = {}) {
  const dataDir = mkdtempSync('/tmp/home-dream-acq-test-');
  const configDir = path.join(dataDir, 'config'); cpSync(new URL('../config/', import.meta.url), configDir, { recursive:true });
  const providers = createProviders({},dataDir); options.modifyProviders?.(providers);
  const app = createApp({ dataDir, env:options.env || {}, config:createConfig(configDir), providers, seed:false, ...options });
  t.after(()=>{app.close();rmSync(dataDir,{recursive:true,force:true});});
  const request=async (route,body,method=body === undefined ? 'GET':'POST',headers={})=>{const r=await inject(app.handler,route,{method,headers,body:body === undefined ? undefined:JSON.stringify(body)});return {status:r.status,body:r.json()};};
  const create=async (handle='test.home')=>(await request('/api/contacts',{handle,name:'Test Homeowner'})).body;
  const message=async (c,text,more={})=>request(`/api/contacts/${c.id}/messages`,{text,eventId:randomUUID(),...more});
  const current=c=>app.service.state().contacts.find(x=>x.id===c.id);
  const calendar=async()=>{const text=app.service.list('messages').find(m=>m.direction==='outbound'&&m.text.includes('/customer#')).text;const token=text.match(/\/customer#([A-Za-z0-9_-]+)/)[1];return {token,...await app.service.customerPages.slots(token)};};
  return {app,request,create,message,current,dataDir,configDir,providers,calendar};
}

test('complete acquisition journey: identified like → first hello → facts → reference → explicit slot → booking',async t=>{
  const f=fixture(t); const c=await f.create();
  assert.equal((await f.request('/api/interactions',{contactId:c.id,type:'like',postId:'home',sourceId:'like-1'})).status,201);
  const outreach=(await f.request(`/api/contacts/${c.id}/outreach`,{})).body;
  assert.equal(outreach.status,'draft');
  assert.equal((await f.request(`/api/outreach/${outreach.id}/execute`,{})).body.status,'simulated_sent');
  await f.message(c,'Bellevue, 2400 sqft, 4 bedrooms and 3 bathrooms, budget $900k. Permit not started.');
  const facts=f.current(c).project.facts;
  for(const id of ['location','square_footage','layout','budget','permit']) { assert.ok(facts[id],id);assert.ok(facts[id].sourceMessageId); }
  assert.equal(f.current(c).project.stage,'qualified');
  f.app.service.addAsset({title:'Concept',url:'/assets/house.svg',approved:true,tags:'home',description:'Sample'});
  await f.message(c,'Show me an example');
  assert.ok(f.app.service.list('messages').some(m=>m.media?.length===1 && /illustrations/.test(m.text)));
  await f.message(c,'Can I book a meeting?');
  assert.equal(f.app.service.list('bookings').length,0);
  const cal=await f.calendar();assert.ok(cal.slots.length>3);
  await f.app.service.customerPages.book(cal.token,cal.slots[0].id);
  assert.equal(f.app.service.list('bookings').length,1);
  assert.equal(f.app.service.list('bookings')[0].status,'simulated');
  assert.equal(f.current(c).project.stage,'meeting_booked');
  await f.app.service.customerPages.book(cal.token,cal.slots[0].id);
  assert.equal(f.app.service.list('bookings').length,1);
  const s=f.app.service.state();assert.equal(s.funnel.total.sent,1);assert.equal(s.funnel.total.replied,1);assert.equal(s.funnel.total.booked,1);
  assert.ok(s.sync.local>0);assert.equal(s.sync.synced,0);
  assert.ok(existsSync(path.join(f.dataDir,'drive-mirror/collected-data/contacts',c.id,'profile.json')));
});

test('unknown answers are saved without repeated checklist interrogation; form and schema reload support added fields',async t=>{
  const f=fixture(t);const c=await f.create();
  await f.message(c,'Hello');const asked=f.current(c).conversation.lastAskedField;assert.ok(asked);
  await f.message(c,'Not sure');assert.equal(f.current(c).project.facts[asked].status,'unknown');assert.notEqual(f.current(c).conversation.lastAskedField,asked);
  const file=path.join(f.configDir,'qualification.schema.json'),schema=JSON.parse(readFileSync(file));
  schema.version++;schema.fields.push({id:'pets',label:'Pets',description:'Pets in the household',type:'text',question:'Any pets at home?',priority:500,askWhen:'project_discussion'});writeFileSync(file,JSON.stringify(schema));
  assert.equal((await f.request('/api/config/reload',{})).status,200);
  await f.message(c,'pets: two dogs');assert.equal(f.current(c).project.facts.pets.value,'two dogs');
  assert.ok(f.app.service.state().config.schema.fields.some(x=>x.id==='pets'));
  schema.fields.push({...schema.fields[0]});writeFileSync(file,JSON.stringify(schema));
  assert.equal((await f.request('/api/config/reload',{})).status,400);
  assert.equal(f.app.service.state().config.schema.version,2);
});

test('quotation is disabled at the tool boundary and legacy endpoints cannot bypass it',async t=>{
  const f=fixture(t);const c=await f.create();await f.message(c,'What will this cost?');
  assert.equal(f.app.service.list('quotes').length,0);
  assert.ok(!f.app.service.list('tool_runs').some(r=>r.name==='get_project_estimate'));
  assert.equal((await f.request('/api/estimates',{areaSqft:2400})).status,410);
  assert.equal((await f.request('/api/settings',{quoteMode:'auto'},'PATCH')).status,409);
  await f.request('/api/settings',{quoteMode:'review_required'},'PATCH');await f.message(c,'Please give me a quote');
  assert.equal(f.app.service.list('quotes').length,0);
  assert.ok(f.app.service.list('tool_runs').some(r=>r.name==='get_project_estimate' && r.status==='failed'));
});

test('human takeover cancels pending drafts, suppresses AI, and requires explicit release',async t=>{
  const f=fixture(t);const c=await f.create();await f.request(`/api/contacts/${c.id}/mode`,{mode:'review'});
  await f.message(c,'Hi');const draft=f.app.service.list('messages').find(m=>m.status==='draft');assert.ok(draft);
  await f.request(`/api/contacts/${c.id}/mode`,{mode:'human'});
  assert.equal(f.app.service.get('messages',draft.id).status,'cancelled');
  assert.equal((await f.request(`/api/messages/${draft.id}/approve`,{})).status,409);
  const count=f.app.service.list('tool_runs').length;await f.message(c,'Can I book a meeting?');assert.equal(f.app.service.list('tool_runs').length,count);
  assert.equal((await f.request(`/api/contacts/${c.id}/reply`,{text:'Hi, this is the project team.'})).body.status,'simulated_sent');
  await f.request(`/api/contacts/${c.id}/mode`,{mode:'auto'});await f.message(c,'Please show me a project example');assert.ok(f.app.service.list('tool_runs').length>count);
});

test('explicit human-only handoff pauses the conversation and preserves history',async t=>{
  const f=fixture(t);const c=await f.create();await f.message(c,'Only a human please, stop the assistant');
  assert.equal(f.current(c).conversation.mode,'awaiting_human');assert.equal(f.app.service.list('handoffs').length,1);
  assert.equal(f.app.service.list('messages').filter(m=>m.direction==='outbound' && m.status==='simulated_sent').length,1);
  await f.message(c,'Are you there?');assert.equal(f.app.service.list('messages').filter(m=>m.direction==='outbound').length,1);
});

test('opt-out stops all automatic outreach and cannot be cleared by mode changes',async t=>{
  const f=fixture(t);const c=await f.create();const job=(await f.request(`/api/contacts/${c.id}/outreach`,{})).body;
  await f.message(c,'Please stop contacting me');assert.equal(f.current(c).doNotContact,true);
  assert.equal(f.app.service.get('outreach',job.id).status,'cancelled');
  assert.equal((await f.request(`/api/outreach/${job.id}/execute`,{})).status,409);
  assert.equal((await f.request(`/api/contacts/${c.id}/mode`,{mode:'auto'})).status,409);
  assert.equal(f.app.service.list('messages').filter(m=>m.direction==='outbound').length,0);
});

test('late webhook event preserves the current reply window and does not trigger another reply',async t=>{
  const f=fixture(t);const c=await f.create();await f.message(c,'Hi');const current=f.current(c).conversation;
  const before=f.app.service.list('messages').filter(m=>m.direction==='outbound').length;
  const result=await f.message(c,'Old message',{receivedAt:new Date(Date.now()-86400000*3).toISOString()});
  assert.equal(result.body.event.status,'superseded');assert.equal(f.current(c).conversation.replyWindowUntil,current.replyWindowUntil);
  assert.equal(f.app.service.list('messages').filter(m=>m.direction==='outbound').length,before);
});

test('expired reply windows block sends and due follow-ups become human actions',async t=>{
  const f=fixture(t);const c=await f.create();await f.message(c,'Hello',{receivedAt:new Date(Date.now()-86400000*2).toISOString()});
  assert.equal(f.app.service.list('messages').find(m=>m.direction==='outbound').status,'blocked');
  const conv=f.current(c).conversation;
  f.app.service.put('tasks',{contactId:c.id,type:'followup',status:'pending',inboundVersion:conv.messageVersion,dueAt:new Date(Date.now()-100).toISOString()});
  await f.request('/api/tasks/run',{});assert.equal(f.app.service.list('tasks')[0].status,'human_action');
});

test('booking is allowed without qualification; duplicate confirmations do not duplicate meetings',async t=>{
  const f=fixture(t);const c=await f.create();await f.message(c,'Book a meeting');const cal=await f.calendar();await f.app.service.customerPages.book(cal.token,cal.slots[0].id);await f.app.service.customerPages.book(cal.token,cal.slots[0].id);
  assert.equal(f.app.service.list('bookings').length,1);assert.equal(f.current(c).project.stage,'meeting_booked');
  assert.equal(Object.keys(f.current(c).project.facts).length,0);
  await f.message(c,'Thank you');assert.ok(f.app.service.list('tasks').some(task=>task.type==='human' && task.status==='pending'));
});

test('legacy numbered appointment replies remain safe for previously sent offers',async t=>{
  const f=fixture(t,{env:{CALENDAR_UI:'text'}});const c=await f.create();await f.message(c,'Book a meeting');
  const second=f.current(c).conversation.offeredSlots[1];
  await f.message(c,'We want 2 bedrooms');
  assert.equal(f.app.service.list('bookings').length,0);
  await f.message(c,'选 2');
  assert.equal(f.app.service.list('bookings').length,1);
  assert.equal(f.app.service.list('bookings')[0].start,second.start);
  await f.message(c,'2');
  assert.equal(f.app.service.list('bookings').length,1);
});

test('unknown calendar writes are never retried and may only be reconciled',async t=>{
  let calls=0;const f=fixture(t,{modifyProviders:p=>{p.calendar.book=async()=>{calls++;throw new Error('response lost');};}});const c=await f.create();
  await f.message(c,'Book a meeting');const cal=await f.calendar();await assert.rejects(()=>f.app.service.customerPages.book(cal.token,cal.slots[0].id),/verify/);await f.app.service.customerPages.book(cal.token,cal.slots[0].id);
  assert.equal(calls,1);assert.equal(f.app.service.list('bookings')[0].status,'unknown');assert.equal(f.current(c).project.bookedAt,null);
});

test('outreach with an uncertain result is excluded from conversions and cannot auto-retry',async t=>{
  let sends=0;const f=fixture(t,{modifyProviders:p=>{p.browser.send=async()=>{sends++;throw new Error('connection lost');};}});const c=await f.create();
  const j=(await f.request(`/api/contacts/${c.id}/outreach`,{})).body;
  assert.equal((await f.request(`/api/outreach/${j.id}/execute`,{})).body.status,'send_unknown');
  assert.equal((await f.request(`/api/outreach/${j.id}/execute`,{})).status,409);assert.equal(sends,1);
  assert.equal(f.app.service.state().funnel.total.sent,0);
  assert.equal((await f.request(`/api/outreach/${j.id}/reconcile`,{result:'sent',evidence:'Verified message in native inbox'})).status,200);
  assert.equal(f.app.service.state().funnel.total.sent,1);
});

test('anonymous views cannot create interactions; null is distinct from zero; immature cohorts are not mature conversion rates',async t=>{
  const f=fixture(t);const c=await f.create();
  assert.equal((await f.request('/api/interactions',{contactId:c.id,type:'view',postId:'house',sourceId:'v1'})).status,400);
  const m=(await f.request('/api/content-metrics',{postId:'house',views:0})).body;assert.equal(m.views,0);assert.equal(m.completionRate,null);
  const now=Date.now(),sentAt=new Date(now-86400000).toISOString();
  const funnel=summarizeFunnel([{id:'c',firstReplyAt:new Date(now-60000).toISOString()}],[{contactId:'c',bookedAt:new Date(now-1000).toISOString()}],[{contactId:'c',status:'sent',sentAt,templateVersion:'v1'}],{observationDays:7},now);
  assert.equal(funnel.total.outreachBookingRate,1);assert.equal(funnel.total.bookingRate,null);assert.equal(funnel.mature.replyRate,null);assert.equal(funnel.observing,1);
});

test('private customer plans stay separate from approved marketing references and sync binary data',async t=>{
  const f=fixture(t);const c=await f.create();
  const pdf=Buffer.from('%PDF-1.4\nexample project plan');
  const r=await f.request(`/api/contacts/${c.id}/attachments`,{name:'plan.pdf',mimeType:'application/pdf',base64:pdf.toString('base64')});
  assert.equal(r.status,200);assert.equal(r.body.private,true);assert.equal(f.app.service.list('assets').length,0);
  assert.deepEqual(readFileSync(path.join(f.dataDir,'drive-mirror',r.body.path)),pdf);
  assert.equal((await inject(f.app.handler,`/private/${path.basename(r.body.path)}`)).status,404);
  assert.equal((await f.request('/api/assets',{name:'bad.png',mimeType:'image/png',base64:pdf.toString('base64')})).status,400);
});

test('failed Drive jobs retain data for retry and cloud status is never faked',async t=>{
  const f=fixture(t);const save=f.providers.drive.save;f.providers.drive.save=async()=>{throw new Error('Drive unavailable');};
  await f.create();await f.app.service.sync();assert.ok(f.app.service.state().sync.failed>0);assert.equal(f.app.service.state().sync.synced,0);
  f.providers.drive.save=save;await f.app.service.sync();assert.equal(f.app.service.state().sync.failed,0);assert.ok(f.app.service.state().sync.local>0);
});

test('SQLite persists contacts and conversations with shared IDs and migrates the legacy primary key',async t=>{
  const f=fixture(t);const c=await f.create();await f.message(c,'location: Bellevue');
  const second=createApp({env:{},dataDir:f.dataDir,seed:false});
  try {assert.equal(second.service.state().contacts[0].project.facts.location.value,'Bellevue');assert.equal(second.service.state().contacts[0].handle,c.handle);}finally{second.close();}
  const legacy=path.join(f.dataDir,'old.sqlite');const db=new DatabaseSync(legacy);db.exec('CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL)');db.prepare('INSERT INTO records VALUES(?,?,?)').run('same','contact',JSON.stringify({id:'same',name:'Alice'}));db.close();
  const migrated=createStore(legacy);try{migrated.put('conversation',{id:'same',mode:'auto'});assert.equal(migrated.get('contact','same').name,'Alice');assert.equal(migrated.get('conversation','same').mode,'auto');}finally{migrated.close();}
});

test('manual lost stage requires a reason; inactivity never marks projects lost',async t=>{
  const f=fixture(t);const c=await f.create();assert.equal((await f.request(`/api/contacts/${c.id}/project`,{stage:'lost'},'PATCH')).status,400);
  assert.equal(f.current(c).project.stage,'prospect');
  await f.message(c,'We chose another builder');assert.equal(f.current(c).project.stage,'lost');assert.match(f.current(c).project.lossReason.reason,/another builder/);
});

test('a concurrent human takeover cancels a pending agent response before sending',async t=>{
  let release,started;const ready=new Promise(resolve=>started=resolve);const wait=new Promise(resolve=>release=resolve);
  const f=fixture(t,{agent:{mode:'mock',run:async()=>{started();await wait;return 'Stale assistant reply';}}});const c=await f.create();
  const processing=f.message(c,'Hi');await ready;await f.request(`/api/contacts/${c.id}/mode`,{mode:'human'});release();await processing;
  const reply=f.app.service.list('messages').find(m=>m.direction==='outbound');assert.equal(reply.status,'cancelled');
});

test('a concurrent handoff cannot turn a stale assistant response into a handoff notice',async t=>{
  let release,started;const ready=new Promise(resolve=>started=resolve);const wait=new Promise(resolve=>release=resolve);
  const f=fixture(t,{agent:{mode:'mock',run:async()=>{started();await wait;return 'Stale assistant reply';}}});const c=await f.create();
  const processing=f.message(c,'Hi');await ready;await f.request(`/api/contacts/${c.id}/handoff`,{reason:'Team requested review',scope:'conversation'});release();await processing;
  assert.equal(f.app.service.list('messages').find(m=>m.direction==='outbound').status,'cancelled');
});

test('webhook signature verification, account filtering, and challenge checks run before ingestion',async t=>{
  const env={INSTAGRAM_APP_SECRET:'test-secret',INSTAGRAM_VERIFY_TOKEN:'verify-test',INSTAGRAM_ACCOUNT_ID:'account'};
  const f=fixture(t,{env});const bytes=JSON.stringify({entry:[{id:'wrong',messaging:[]}]});
  assert.equal((await inject(f.app.handler,'/webhooks/instagram',{method:'POST',body:bytes})).status,403);
  const signature=`sha256=${createHmac('sha256',env.INSTAGRAM_APP_SECRET).update(bytes).digest('hex')}`;
  assert.equal((await inject(f.app.handler,'/webhooks/instagram',{method:'POST',body:bytes,headers:{'x-hub-signature-256':signature}})).json().accepted,0);
  const verified=await inject(f.app.handler,'/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-test&hub.challenge=12345');assert.equal(verified.text(),'12345');
});

test('malformed input, cross-origin writes, traversal and optional workspace authentication are enforced',async t=>{
  const f=fixture(t);assert.equal((await inject(f.app.handler,'/api/contacts',{method:'POST',body:'{bad'})).status,400);
  assert.equal((await f.request('/api/contacts',{handle:'test'},'POST',{origin:'https://foreign.example'})).status,403);
  assert.equal((await inject(f.app.handler,'/%2e%2e%2fpackage.json')).status,404);
  assert.equal((await inject(f.app.handler,'/intake')).status,200);
  const protectedApp=createApp({env:{WORKSPACE_TOKEN:'token-test'},dataDir:path.join(f.dataDir,'protected'),seed:false});
  try {assert.equal((await inject(protectedApp.handler,'/api/state')).status,401);assert.equal((await inject(protectedApp.handler,'/api/state',{headers:{authorization:'Bearer token-test'}})).status,200);}finally{protectedApp.close();}
});

test('process recovery quarantines interrupted sends and bookings instead of replaying them',async t=>{
  const f=fixture(t);const c=await f.create();
  const m=f.app.service.put('messages',{contactId:c.id,direction:'outbound',status:'sending',text:'Uncertain'});
  const o=f.app.service.put('outreach',{contactId:c.id,status:'sending'});
  const b=f.app.service.put('bookings',{contactId:c.id,projectId:f.current(c).project.id,status:'pending'});
  f.app.service.recoverInterrupted();
  assert.equal(f.app.service.get('messages',m.id).status,'send_unknown');assert.equal(f.app.service.get('outreach',o.id).status,'send_unknown');assert.equal(f.app.service.get('bookings',b.id).status,'unknown');
  assert.equal(f.current(c).outreachStatus,'send_unknown');
});

test('concurrent task runners do not send a due follow-up twice',async t=>{
  const f=fixture(t);const c=await f.create();await f.message(c,'Hello');
  const task=f.app.service.list('tasks').find(t=>t.type==='followup');f.app.service.put('tasks',{...task,dueAt:new Date(Date.now()-1000).toISOString()});
  let sends=0;const send=f.providers.instagram.send;f.providers.instagram.send=async input=>{sends++;await new Promise(resolve=>setImmediate(resolve));return send(input);};
  await Promise.all([f.app.service.runTasks(),f.app.service.runTasks()]);assert.equal(sends,1);
});

test('topic questions remain open across human ownership changes; a team answer sends verbatim without disabling the agent',async t=>{
  const f=fixture(t);const c=await f.create();await f.message(c,'Hello');
  const issue=(await f.request(`/api/contacts/${c.id}/handoff`,{reason:'Confirm countertop material',scope:'topic'})).body;
  assert.equal(f.current(c).conversation.mode,'auto');
  await f.request(`/api/contacts/${c.id}/mode`,{mode:'human'});await f.request(`/api/contacts/${c.id}/mode`,{mode:'auto'});
  assert.equal(f.app.service.get('handoffs',issue.id).status,'waiting');
  const result=await f.request(`/api/handoffs/${issue.id}/resolve`,{answer:'The verified countertop specification is quartz.',sendToCustomer:true});
  assert.equal(result.body.status,'resolved');assert.equal(f.current(c).conversation.mode,'auto');
  const message=f.app.service.get('messages',result.body.answerMessageId);assert.equal(message.text,'The verified countertop specification is quartz.');assert.equal(message.author,'human');assert.equal(message.status,'simulated_sent');
  await f.message(c,'Can I book a meeting?');assert.ok((await f.calendar()).slots.length>3);
});

test('a one-off human reply invalidates an in-flight AI draft without taking over the conversation',async t=>{
  let release,started;const ready=new Promise(resolve=>started=resolve),wait=new Promise(resolve=>release=resolve);
  const f=fixture(t,{agent:{mode:'mock',run:async()=>{started();await wait;return 'Outdated draft';}}});const c=await f.create();
  const processing=f.message(c,'Hi');await ready;
  const result=await f.request(`/api/contacts/${c.id}/reply`,{text:'Hi, our team has a quick clarification.'});
  release();await processing;
  assert.equal(result.body.status,'simulated_sent');assert.equal(f.current(c).conversation.mode,'auto');
  assert.equal(f.app.service.list('messages').find(m=>m.author==='agent').status,'cancelled');
});

test('a question is recorded as asked only when the reply is actually sent',async t=>{
  const f=fixture(t);f.app.service.updateSettings({replyMode:'review'});const c=await f.create();
  await f.message(c,'Hi');const draft=f.app.service.list('messages').find(m=>m.status==='draft');
  assert.ok(draft.questionField);assert.equal(f.current(c).project.asked[draft.questionField],undefined);assert.equal(f.current(c).conversation.lastAskedField,null);
  await f.app.service.approveReply(draft.id);assert.ok(f.current(c).project.asked[draft.questionField]);assert.equal(f.current(c).conversation.lastAskedField,draft.questionField);
});

test('failed model turns can recover without duplicate sends; booking attempts require reconciliation',async t=>{
  let fails=true;const agent={mode:'mock',async run(){if(fails)throw new Error('fetch failed');return 'Which city is your project in?';}};
  const f=fixture(t,{agent}),c=await f.create();await f.message(c,'Hi');const e=f.app.service.list('inbound_events')[0];assert.equal(e.status,'failed');
  fails=false;await f.app.service.retryFailedEvent(e.id);assert.equal(f.app.service.list('messages').filter(m=>m.direction==='outbound').length,1);assert.equal(f.app.service.list('handoffs')[0].status,'resolved');
  await assert.rejects(()=>f.app.service.retryFailedEvent(e.id),/latest failed/);
  fails=true;await f.message(c,'Next');const next=f.app.service.list('inbound_events')[0];f.app.service.put('tool_runs',{sourceMessageId:next.messageId,name:'book_meeting'});await assert.rejects(()=>f.app.service.retryFailedEvent(next.id),/reconcile/);
});
