import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID, createHmac } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { createProviders } from '../server/acquisition/providers.mjs';
import { inject } from './http-harness.mjs';

function fixture(t, agent) {
  const dataDir=mkdtempSync('/tmp/acquisition-buttons-');const env={INSTAGRAM_ACCOUNT_ID:'900',INSTAGRAM_APP_SECRET:'test-secret'};
  const app=createApp({dataDir,env,seed:false,...(agent?{agent}:{})});t.after(()=>{app.close();rmSync(dataDir,{recursive:true,force:true});});
  const s=app.service,c=s.createContact({handle:'button.customer',instagramId:'200'});
  const send=(text,more={})=>s.receive({contactId:c.id,eventId:randomUUID(),text,...more});
  const latest=()=>s.list('messages').find(m=>m.direction==='outbound');
  return {app,s,c,env,send,latest};
}

test('first reply includes website; configured city button saves exact fact and stale buttons cannot overwrite it',async t=>{
  const f=fixture(t);await f.send('Hi');const first=f.latest();assert.ok(first.text.includes(f.s.config.get().business.website));
  const choice=first.quickReplies.find(q=>q.title==='Bellevue');assert.ok(choice);
  await f.send(choice.title,{quickReplyPayload:choice.payload});let p=f.s.state().contacts[0].project;
  assert.equal(p.facts.location.value,'Bellevue');assert.equal(p.facts.location.author,'customer_button');
  const stale=first.quickReplies.find(q=>q.title==='Seattle');await f.send(stale.title,{quickReplyPayload:stale.payload});
  p=f.s.state().contacts[0].project;assert.equal(p.facts.location.value,'Bellevue');assert.match(f.latest().text,/earlier question/);
});

test('reference yes/no answer has its own identity and does not turn a budget yes into a numeric budget',async t=>{
  const agent={mode:'mock',async run(ctx){if(ctx.text==='ask budget'){await ctx.call('ask_reference_question',{questionId:'budget_set'});return 'Have you set a budget for your new home?';}return 'Thanks, I have saved that.';}};
  const f=fixture(t,agent);await f.send('ask budget');const q=f.latest().quickReplies.find(q=>q.title==='Yes');
  await f.send('Yes',{quickReplyPayload:q.payload});const p=f.s.state().contacts[0].project;
  assert.equal(p.questionnaireAnswers.budget_set.value,'yes');assert.equal(p.facts.budget,undefined);assert.equal(f.s.list('bookings').length,0);
});

test('not sure is retained as unknown and ownership changes invalidate old buttons',async t=>{
  const f=fixture(t);await f.send('Hi');const q=f.latest().quickReplies.find(q=>q.title==='Not sure yet');
  await f.send(q.title,{quickReplyPayload:q.payload});assert.equal(f.s.state().contacts[0].project.facts.location.status,'unknown');
  const choice=f.latest().quickReplies[0];await f.s.mode(f.c.id,{mode:'review'});
  await f.send(choice.title,{quickReplyPayload:choice.payload});assert.match(f.latest().text,/earlier question/);
});

test('free consultation button checks times, selected slot books once, and Not now never books',async t=>{
  const f=fixture(t);await f.send('Can a real person help with this detail?');const offer=f.latest();assert.match(offer.text,/free initial consultation/);
  const yes=offer.quickReplies.find(q=>q.action.value==='yes');await f.send(yes.title,{quickReplyPayload:yes.payload});
  assert.equal(f.latest().quickReplies.length,0);const token=f.latest().text.match(/\/customer#([A-Za-z0-9_-]+)/)[1];const {slots}=await f.s.customerPages.slots(token);assert.ok(slots.length>3);assert.equal(f.s.list('bookings').length,0);
  await f.s.customerPages.book(token,slots[1].id);assert.equal(f.s.list('bookings').length,1);await f.s.customerPages.book(token,slots[1].id);assert.equal(f.s.list('bookings').length,1);
  const second=fixture(t);await second.send('Can a real person help?');const no=second.latest().quickReplies.find(q=>q.action.value==='no');await second.send(no.title,{quickReplyPayload:no.payload});assert.equal(second.s.list('bookings').length,0);assert.equal(second.s.get('conversations',second.c.id).mode,'auto');
});

test('signed Instagram quick reply webhook forwards payload and writes the selected field',async t=>{
  const f=fixture(t);await f.send('Hi');const q=f.latest().quickReplies.find(q=>q.title==='Bellevue');
  const body=JSON.stringify({entry:[{id:'900',messaging:[{sender:{id:'200'},recipient:{id:'900'},timestamp:Date.now(),message:{mid:'clicked-once',text:q.title,quick_reply:{payload:q.payload}}}]}]});
  const signature='sha256='+createHmac('sha256',f.env.INSTAGRAM_APP_SECRET).update(body).digest('hex');
  const r=await inject(f.app.handler,'/webhooks/instagram',{method:'POST',headers:{'x-hub-signature-256':signature},body});assert.equal(r.status,200);await f.s.tick();assert.equal(f.s.state().contacts[0].project.facts.location.value,'Bellevue');
});

test('Instagram sends text quick replies without exposing internal actions',async t=>{
  const dir=mkdtempSync('/tmp/instagram-choices-'),old=globalThis.fetch;let payload;
  t.after(()=>{globalThis.fetch=old;rmSync(dir,{recursive:true,force:true});});
  globalThis.fetch=async(url,init)=>{payload=JSON.parse(init.body);return new Response(JSON.stringify({message_id:'sent-1'}));};
  const p=createProviders({INSTAGRAM_PROVIDER:'instagram',INSTAGRAM_ACCOUNT_ID:'900',INSTAGRAM_API_VERSION:'v26.0',INSTAGRAM_ACCESS_TOKEN:'test',INSTAGRAM_APP_SECRET:'test',INSTAGRAM_VERIFY_TOKEN:'test'},dir);
  await p.instagram.send({contact:{instagramId:'200',demo:false},text:'Do you have blueprints?',quickReplies:[{title:'Yes',payload:'choice:test',action:{type:'field',fieldId:'blueprints',value:'available'}}]});
  assert.deepEqual(payload.message.quick_replies,[{content_type:'text',title:'Yes',payload:'choice:test'}]);assert.equal(payload.message.text,'Do you have blueprints?');
});

test('offline demo typed Yes answers the latest reference question without requiring a button payload',async t=>{
  const agent={mode:'mock',async run(ctx){if(ctx.text==='ask land'){await ctx.call('ask_reference_question',{questionId:'land_owned'});return 'Do you already own the land?';}return 'Thanks, I have saved that.';}};
  const f=fixture(t,agent);await f.send('ask land');await f.send('yes');assert.equal(f.s.state().contacts[0].project.questionnaireAnswers.land_owned.value,'yes');assert.equal(f.s.list('bookings').length,0);
});
