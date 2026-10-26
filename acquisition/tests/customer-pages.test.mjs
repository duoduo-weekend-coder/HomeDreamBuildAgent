import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.mjs';
import {inject} from './http-harness.mjs';
import {consultationReadiness} from '../server/acquisition/policy.mjs';

function fixture(t,agent){const dataDir=mkdtempSync('/tmp/customer-pages-');const app=createApp({dataDir,env:{WORKSPACE_TOKEN:'workspace-secret'},seed:false,...(agent?{agent}:{})});t.after(()=>{app.close();rmSync(dataDir,{recursive:true,force:true});});const s=app.service,c=s.createContact({handle:'calendar.customer'});const link=kind=>s.customerPages.create(c.id,kind).url.split('#')[1];const send=text=>s.receive({contactId:c.id,eventId:randomUUID(),text});return {app,s,c,link,send};}

test('calendar is default, shows more than three slots and books only after explicit page confirmation',async t=>{
 const f=fixture(t);await f.send('Book a meeting');const m=f.s.list('messages').find(m=>m.direction==='outbound');assert.match(m.text,/calendar/);assert.deepEqual(m.quickReplies,[]);assert.equal(f.s.list('bookings').length,0);
 const token=m.text.match(/\/customer#([A-Za-z0-9_-]+)/)[1],cal=await f.s.customerPages.slots(token);assert.equal(cal.days.length,14);assert.ok(cal.slots.length>3);
 await assert.rejects(()=>f.s.customerPages.book(token,'not-offered'),/Select a time/);
 const slot=cal.slots.at(-1);const [a,b]=await Promise.all([f.s.customerPages.book(token,slot.id),f.s.customerPages.book(token,slot.id)]);assert.equal(a.booking.start,slot.start);assert.deepEqual(a,b);assert.equal(f.s.list('bookings').length,1);assert.equal(f.s.state().contacts[0].project.stage,'meeting_booked');
});

test('customer capability cannot read CRM; revoked and expired links are rejected',async t=>{
 const f=fixture(t),token=f.link('booking');
 const request=(route,tok)=>inject(f.app.handler,route,{headers:{authorization:`Bearer ${tok}`}});
 assert.equal((await request('/api/state',token)).status,401);assert.equal((await request('/api/customer/session','bad')).status,401);
 const r=await request('/api/customer/session',token);assert.equal(r.status,200);const data=r.json();assert.equal(data.contactId,undefined);assert.equal(data.email,undefined);assert.equal(data.facts,undefined);
 await f.s.mode(f.c.id,{mode:'human'});await assert.rejects(()=>f.s.customerPages.slots(token),/no longer active/);
 await f.s.mode(f.c.id,{mode:'auto'});const expired=f.link('booking');const sess=f.s.list('customer_sessions')[0];f.s.put('customer_sessions',{...sess,expiresAt:new Date(0).toISOString()});assert.throws(()=>f.s.customerPages.session(expired),/expired/);
});

test('calendar rechecks conflicts and never repeats uncertain provider writes',async t=>{
 const f=fixture(t),token=f.link('booking'),cal=await f.s.customerPages.slots(token);const original=f.s.providers.calendar.availability;
 f.s.providers.calendar.availability=async()=>[];await assert.rejects(()=>f.s.customerPages.book(token,cal.slots[0].id),/no longer available/);assert.equal(f.s.list('bookings').length,0);f.s.providers.calendar.availability=original;
 let writes=0;f.s.providers.calendar.book=async()=>{writes++;throw new Error('timeout after write');};await assert.rejects(()=>f.s.customerPages.book(token,cal.slots[0].id),/verify/);const again=await f.s.customerPages.book(token,cal.slots[0].id);assert.equal(again.booking.status,'unknown');assert.equal(writes,1);
});

test('reference form curates discovery questions, saves Yes/No separately, and resumes chat without reopening the form',async t=>{
 const f=fixture(t);await f.send('Hi');const before=f.s.get('conversations',f.c.id).replyWindowUntil;const token=f.link('intake');const page=f.s.customerPages.session(token);
 assert.equal(page.fields,undefined);assert.equal(page.questions.length,19);assert.deepEqual(page.questions.map(q=>q.number),Array.from({length:19},(_,i)=>i+1));assert.equal(page.questions[1].id,'land_owned');assert.deepEqual(page.questions.slice(-2).map(q=>q.id),['enjoy_reels','housewarming']);assert.ok(page.questions.some(q=>q.id==='financing_ready'));assert.ok(!page.questions.some(q=>q.id==='specialist_call'));
 await f.s.customerPages.intake(token,[{questionId:'budget_set',value:'yes'},{questionId:'land_owned',value:'no'}]);await f.s.tick();const p=f.s.state().contacts[0].project;
 assert.equal(p.questionnaireAnswers.budget_set.value,'yes');assert.equal(p.questionnaireAnswers.land_owned.author,'customer_form');assert.equal(p.questionnaireAnswers.designer,undefined);assert.equal(p.facts.budget,undefined);assert.equal(p.facts.location,undefined);assert.equal(p.bookingIntent,false);assert.equal(f.s.get('conversations',f.c.id).replyWindowUntil,before);assert.equal(f.s.get('conversations',f.c.id).mode,'auto');
 assert.equal(f.s.list('customer_sessions').length,1);assert.equal(f.s.list('bookings').length,0);const reply=f.s.list('messages').find(m=>m.direction==='outbound');assert.doesNotMatch(reply.text,/customer#/);assert.ok(['location','budget','square_footage','layout'].includes(reply.questionField));
 await f.s.customerPages.intake(token,[{questionId:'budget_set',value:'no'}]);assert.equal(f.s.state().contacts[0].project.questionnaireAnswers.budget_set.value,'yes');assert.equal(f.s.state().contacts[0].project.questionnaireHistory.length,1);
});

test('stale reference form cannot overwrite newer answers, but unrelated numeric chat facts remain intact',async t=>{
 const f=fixture(t),token=f.link('intake');f.s.customerPages.session(token);f.s.saveFacts(f.c.id,{updates:[{fieldId:'location',value:'Bellevue',status:'confirmed'}]});
 const p=f.s.state().contacts[0].project;f.s.put('projects',{...p,questionnaireAnswers:{land_owned:{value:'yes',updatedAt:new Date().toISOString()}}});
 await assert.rejects(()=>f.s.customerPages.intake(token,[{questionId:'land_owned',value:'no'}]),/updated in chat/);
 await f.s.customerPages.intake(token,[{questionId:'budget_set',value:'yes'}]);assert.equal(f.s.state().contacts[0].project.facts.location.value,'Bellevue');assert.equal(f.s.state().contacts[0].project.questionnaireAnswers.land_owned.value,'yes');await assert.rejects(()=>f.s.customerPages.slots(token),/invalid or expired/);
});

test('reference form rejects numeric fields, invented answers, duplicate IDs and outdated question definitions',async t=>{
 const f=fixture(t),token=f.link('intake');f.s.customerPages.session(token);
 for(const updates of [[{fieldId:'budget',value:'900000',status:'confirmed'}],[{questionId:'budget_set',value:'900000'}],[null],[{questionId:'invented',value:'yes'}],[{questionId:'budget_set',value:'yes'},{questionId:'budget_set',value:'no'}]])await assert.rejects(()=>f.s.customerPages.intake(token,updates));
 f.s.config.get().questionnaire.questions[0].formQuestion='Updated question';await assert.rejects(()=>f.s.customerPages.intake(token,[{questionId:'budget_set',value:'yes'}]),/questionnaire has changed/);assert.deepEqual(f.s.state().contacts[0].project.facts,{});
});

test('consultation cannot be submitted through the discovery form, and a stale full questionnaire is rejected',async t=>{
 const f=fixture(t);await f.send('Hi');const token=f.link('intake');f.s.customerPages.session(token);
 await assert.rejects(()=>f.s.customerPages.intake(token,[{questionId:'specialist_call',value:'yes'}]),/reference question/);
 const session=f.s.list('customer_sessions')[0];f.s.put('customer_sessions',{...session,formSignature:'old-20-question-form'});
 await assert.rejects(()=>f.s.customerPages.intake(token,[{questionId:'budget_set',value:'yes'}]),/questionnaire has changed/);
 assert.equal(f.s.list('bookings').length,0);assert.equal(f.s.list('customer_sessions').length,1);
});

test('three facts cannot trigger an unsolicited consultation, including a model that ignores tool rejection',async t=>{
 const agent={mode:'mock',async run(ctx){const r=await ctx.call('offer_free_consultation',{});assert.ok(r.error);return 'Thanks for sharing. Would you like a free initial consultation with our team?';}};
 const f=fixture(t,agent);f.s.saveFacts(f.c.id,{updates:[{fieldId:'location',value:'Seattle',status:'confirmed'},{fieldId:'permit',value:'in_progress',status:'confirmed'},{fieldId:'blueprints',value:'not_yet',status:'confirmed'}]});await f.send('Okay');const m=f.s.list('messages').find(m=>m.direction==='outbound');assert.doesNotMatch(m.text,/Would you like a free initial consultation/);assert.ok(m.questionField);assert.ok(!m.quickReplies.some(q=>q.action.type==='consultation'));assert.equal(f.s.state().contacts[0].conversation.mode,'auto');
 const p=f.s.state().contacts[0].project;for(const id of ['budget','square_footage','layout'])p.facts[id]={status:'unknown',value:'Not sure'};assert.equal(consultationReadiness(p,f.s.config.get().schema).allowed,true);
});

test('form is offered with consent buttons; only acceptance generates a customer link',async t=>{
 const agent={mode:'mock',async run(ctx){if(ctx.snapshot().formRequested){await ctx.call('get_intake_form',{});return 'Here is your form.';}await ctx.call('offer_short_form',{});return 'Would you like a one-minute project form, or prefer to keep chatting?';}};
 const f=fixture(t,agent);await f.send('Hi');let m=f.s.list('messages').find(m=>m.direction==='outbound');assert.equal(f.s.list('customer_sessions').length,0);assert.equal(m.quickReplies.length,2);const yes=m.quickReplies.find(q=>q.action.value==='yes');await f.s.receive({contactId:f.c.id,eventId:'accept-form',text:yes.title,quickReplyPayload:yes.payload});m=f.s.list('messages').find(m=>m.direction==='outbound');assert.match(m.text,/customer#/);assert.equal(f.s.list('customer_sessions')[0].kind,'intake');
});

test('project interest proactively triggers one-minute form offer without customer asking, and decline is respected',async t=>{
 const agent={mode:'mock',async run(){return 'Which city is your project in?';}};const f=fixture(t,agent);
 await f.send('Hi');assert.equal(f.s.list('messages').filter(m=>m.formOffered).length,0);
 await f.send('I want to build a house');let m=f.s.list('messages').find(m=>m.direction==='outbound');assert.equal(m.formOffered,true);assert.match(m.text,/1 minute/);assert.match(m.text,/Yes\/No/);assert.match(m.text,/understand the basics/);assert.equal(f.s.list('customer_sessions').length,0);
 const no=m.quickReplies.find(q=>q.action.type==='form'&&q.action.value==='no');await f.s.receive({contactId:f.c.id,eventId:'decline-form',text:no.title,quickReplyPayload:no.payload});await f.send('Seattle');assert.equal(f.s.list('messages').filter(m=>m.formOffered).length,1);assert.equal(f.s.list('customer_sessions').length,0);
});

test('an own-message echo arriving before send response does not take over the conversation or invalidate links',async t=>{
 const f=fixture(t);f.s.put('contacts',{...f.c,instagramId:'200'});await f.send('Hi');const token=f.link('intake');
 f.s.providers.instagram.send=async()=>{await f.s.receiveEcho('early-echo','200');assert.equal(f.s.get('conversations',f.c.id).mode,'auto');assert.equal(f.s.list('echoes')[0].status,'queued');return {status:'sent',externalId:'early-echo'};};
 const m=await f.s.humanReply(f.c.id,{text:'Your form link is ready.'});assert.equal(m.status,'sent');assert.equal(f.s.get('conversations',f.c.id).mode,'auto');assert.equal(f.s.list('echoes')[0].status,'matched');assert.equal(f.s.customerPages.session(token).kind,'intake');
});

test('a genuine native reply during an API send still causes human takeover after IDs are reconciled',async t=>{
 const f=fixture(t);f.s.put('contacts',{...f.c,instagramId:'200'});await f.send('Hi');const token=f.link('intake');
 f.s.providers.instagram.send=async()=>{await f.s.receiveEcho('native-human-mid','200');return {status:'sent',externalId:'own-api-mid'};};
 await f.s.humanReply(f.c.id,{text:'API reply'});assert.equal(f.s.get('conversations',f.c.id).mode,'human');assert.throws(()=>f.s.customerPages.session(token),/no longer active/);
 const version=f.s.get('conversations',f.c.id).ownershipVersion;await f.s.receiveEcho('own-api-mid','200');assert.equal(f.s.get('conversations',f.c.id).ownershipVersion,version);
});


test('form turn cannot infer numeric facts or offer a consultation before sufficient discovery',async t=>{ let formModelCalled=false;
 const agent={mode:'mock',async run(ctx){
   if(ctx.snapshot().formSubmission)formModelCalled=true;
   return 'Thanks, your preferences are saved.';
 }};
 const f=fixture(t,agent);await f.send('Hi');const token=f.link('intake');f.s.customerPages.session(token);
 await f.s.customerPages.intake(token,[{questionId:'budget_set',value:'yes'}]);await f.s.tick();
 assert.equal(formModelCalled,false);
 assert.equal(f.s.state().contacts[0].project.facts.budget,undefined);assert.equal(f.s.list('customer_sessions').length,1);assert.equal(f.s.list('bookings').length,0);
});


test('owning land routes the form follow-up to lot area and saves it separately from home size',async t=>{
 const f=fixture(t);await f.send('Hi');const token=f.link('intake');f.s.customerPages.session(token);
 await f.s.customerPages.intake(token,[{questionId:'land_owned',value:'yes'},{questionId:'enjoy_reels',value:'yes'}]);await f.s.tick();
 let reply=f.s.list('messages').find(m=>m.direction==='outbound');assert.equal(reply.questionField,'lot_area');assert.match(reply.text,/large is your lot/);assert.equal(f.s.state().contacts[0].signals.intent,'exploring');
 await f.send('6000 sq ft');const p=f.s.state().contacts[0].project;assert.equal(p.facts.lot_area.value,'6000 sq ft');assert.equal(p.facts.square_footage,undefined);
 reply=f.s.list('messages').find(m=>m.direction==='outbound');assert.notEqual(reply.questionField,'lot_area');
});

test('no, unknown or omitted land ownership skips lot-specific follow-up without inventing a lot size',async t=>{
 for(const value of ['no','unknown',null]){
  const f=fixture(t);await f.send('Hi');const token=f.link('intake');f.s.customerPages.session(token);
  await f.s.customerPages.intake(token,[{questionId:'planning_help',value:'yes'},...(value?[{questionId:'land_owned',value}]:[])]);await f.s.tick();
  const reply=f.s.list('messages').find(m=>m.direction==='outbound');assert.notEqual(reply.questionField,'lot_area');assert.doesNotMatch(reply.text,/your lot|land size/);assert.equal(f.s.state().contacts[0].project.facts.lot_area,undefined);
 }
});

test('unset budget and answered blueprint status are not re-asked after the form',async t=>{
 const f=fixture(t);await f.send('Hi');f.s.saveFacts(f.c.id,{updates:['location','square_footage','layout','permit'].map(fieldId=>({fieldId,value:fieldId==='permit'?'not_started':fieldId==='location'?'Seattle':'Known detail',status:'confirmed'}))});
 const token=f.link('intake');f.s.customerPages.session(token);
 await f.s.customerPages.intake(token,[{questionId:'budget_set',value:'no'},{questionId:'blueprints',value:'yes'},{questionId:'land_owned',value:'no'}]);await f.s.tick();
 const reply=f.s.list('messages').find(m=>m.direction==='outbound');assert.equal(reply.questionField,null);assert.doesNotMatch(reply.text,/budget|blueprints|consultation/);const p=f.s.state().contacts[0].project;assert.equal(p.facts.budget,undefined);assert.equal(p.facts.blueprints,undefined);
});
