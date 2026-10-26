import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.mjs';

function fixture(t,{env={},agent}={}) {
 const dir=mkdtempSync('/tmp/developer-reset-');const app=createApp({dataDir:dir,seed:false,env:{DEVELOPER_TEST_RESET_ENABLED:'true',DEVELOPER_TEST_INSTAGRAM_IDS:'200',...env},...(agent?{agent}:{})});
 t.after(()=>{app.close();rmSync(dir,{recursive:true,force:true});});const s=app.service,c=s.createContact({handle:'tester',instagramId:'200'});const send=(text,more={},background=false)=>s.receive({contactId:c.id,eventId:randomUUID(),text,...more},background);return {app,s,c,send};
}

test('allowlisted hi starts fresh context, facts, greeting and links while preserving the old audit and booking',async t=>{
 const snapshots=[];const agent={mode:'mock',async run(ctx){snapshots.push(ctx.snapshot());return 'Which city is your project in?';}};
 const f=fixture(t,{agent});await f.send('OLD_PRIVATE_PROJECT');const old=f.s.get('conversations',f.c.id);f.s.saveFacts(f.c.id,{updates:[{fieldId:'budget',value:'OLD_BUDGET',status:'confirmed'}]});
 const p=f.s.get('projects',old.projectId);f.s.put('projects',{...p,questionnaireAnswers:{land_owned:{value:'yes'}},intakeSubmittedAt:new Date().toISOString()});
 f.s.put('conversations',{...f.s.get('conversations',f.c.id),formOfferedAt:new Date().toISOString(),sourcePostId:'old-post',lastAssistantMeetingOffer:true});
 const h=f.s.handoff(f.c.id,'Old material question');f.s.put('handoffs',{...h,status:'resolved',answer:'OLD_TEAM_ANSWER'});
 const link=f.s.customerPages.create(f.c.id,'intake').url.split('#')[1];const b=f.s.put('bookings',{contactId:f.c.id,projectId:old.projectId,status:'simulated'});
 await f.send(' Hi ');const current=f.s.get('conversations',f.c.id);assert.notEqual(current.projectId,old.projectId);assert.equal(current.mode,'auto');assert.equal(current.developerTestRound,1);assert.equal(current.sourcePostId,null);assert.equal(current.formOfferedAt,null);
 assert.deepEqual(f.s.get('projects',current.projectId).facts,{});assert.equal(f.s.get('projects',current.projectId).questionnaireAnswers,undefined);
 const state=f.s.state();assert.equal(state.projects.length,1);assert.equal(state.bookings.length,0);assert.equal(f.s.get('bookings',b.id).status,'simulated');assert.equal(f.s.get('projects',old.projectId).archivedTest,true);
 assert.equal(state.messages.filter(m=>m.direction==='inbound').length,1);const greeting=state.messages.find(m=>m.direction==='outbound');assert.equal(greeting.text,f.s.config.get().templates.intro);assert.equal(greeting.quickReplies.length,2);
 assert.throws(()=>f.s.customerPages.session(link),/no longer active/);await f.send('Continue');const snap=snapshots.at(-1);assert.deepEqual(snap.project.facts,{});assert.deepEqual(snap.teamAnswers,[]);assert.ok(!snap.messages.some(m=>m.text.includes('OLD_PRIVATE')));
});

test('ordinary customers, matching usernames and disabled developer mode cannot reset with hi',async t=>{
 const f=fixture(t);const other=f.s.createContact({handle:'tester',instagramId:'999'});const conv=f.s.get('conversations',other.id);f.s.saveFacts(other.id,{updates:[{fieldId:'location',value:'Seattle',status:'confirmed'}]});f.s.put('contacts',{...other,doNotContact:true});await f.s.mode(other.id,{mode:'paused'});
 await f.s.receive({contactId:other.id,eventId:'normal-hi',text:'hi'});assert.equal(f.s.get('conversations',other.id).projectId,conv.projectId);assert.equal(f.s.get('conversations',other.id).mode,'paused');assert.equal(f.s.get('contacts',other.id).doNotContact,true);assert.equal(f.s.state().contacts.find(c=>c.id===other.id).project.facts.location.value,'Seattle');
 const disabled=fixture(t,{env:{DEVELOPER_TEST_RESET_ENABLED:'false'}});const previous=disabled.s.get('conversations',disabled.c.id).projectId;await disabled.send('hi');assert.equal(disabled.s.get('conversations',disabled.c.id).projectId,previous);assert.equal(disabled.s.list('developer_test_runs').length,0);
});

test('duplicate and historical hi events do not reset again; only a standalone current hi does',async t=>{
 const f=fixture(t);await f.send('HI',{eventId:'one-hi'});const project=f.s.get('conversations',f.c.id).projectId;await f.send('HI',{eventId:'one-hi'});await f.send('hi',{receivedAt:new Date(Date.now()-3600000).toISOString()});await f.send('hi, I have a project');
 assert.equal(f.s.list('developer_test_runs').length,1);assert.equal(f.s.get('conversations',f.c.id).projectId,project);assert.ok(!f.s.state().messages.some(m=>m.status==='historical'));
 f.s.put('contacts',{...f.s.get('contacts',f.c.id),doNotContact:true});await f.s.mode(f.c.id,{mode:'paused'});await f.send('hi');assert.equal(f.s.list('developer_test_runs').length,2);assert.equal(f.s.get('contacts',f.c.id).doNotContact,false);assert.equal(f.s.get('conversations',f.c.id).mode,'auto');
});

test('reset supersedes a model turn in flight and prevents its old reply from entering the new test round',async t=>{
 let release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);const agent={mode:'mock',async run(){started();await gate;return 'OLD_STALE_REPLY';}};
 const f=fixture(t,{agent});const old=f.s.get('conversations',f.c.id).projectId;await f.send('Old question',{},true);await ready;await f.send('hi',{},true);release();await f.s.tick();
 const stale=f.s.list('messages').find(m=>m.text.startsWith('OLD_STALE_REPLY'));assert.equal(stale.status,'cancelled');assert.equal(stale.projectId,old);assert.ok(!f.s.state().messages.some(m=>m.text.startsWith('OLD_STALE_REPLY')));assert.ok(f.s.state().messages.some(m=>m.text===f.s.config.get().templates.intro));
});

test('a previously confirmed booking finishing during reset stays attached to the old project',async t=>{
 const f=fixture(t);await f.send('Book a meeting');const before=f.s.get('conversations',f.c.id).projectId;const token=f.s.list('messages').find(m=>m.text.includes('/customer#')).text.match(/\/customer#([A-Za-z0-9_-]+)/)[1];const {slots}=await f.s.customerPages.slots(token);
 let release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);f.s.providers.calendar.book=async()=>{started();await gate;return {status:'simulated',externalId:'old-confirmed-booking'};};
 const booking=f.s.customerPages.book(token,slots[0].id);await ready;await f.send('hi',{},true);release();await booking;await f.s.tick();
 const current=f.s.state().contacts[0];assert.notEqual(current.project.id,before);assert.equal(current.project.bookedAt,null);assert.notEqual(current.project.stage,'meeting_booked');assert.equal(f.s.state().bookings.length,0);assert.equal(f.s.list('bookings')[0].status,'simulated');assert.equal(f.s.list('bookings')[0].projectId,before);
});
