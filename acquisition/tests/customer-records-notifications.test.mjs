import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {createApp} from '../server/app.mjs';
import {inject} from './http-harness.mjs';
function fixture(t,env={}){const dir=mkdtempSync('/tmp/team-record-'),app=createApp({dataDir:dir,seed:false,env});t.after(()=>{app.close();rmSync(dir,{recursive:true,force:true});});const s=app.service,c=s.createContact({handle:'chat.customer'});return {dir,app,s,c};}

test('a direct human request queues one live chat alert, offers free consultation and keeps the assistant active',async t=>{
 const {s,c}=fixture(t);
 await s.receive({contactId:c.id,eventId:'human-1',text:'Could I speak with a real person here?'});
 const h=s.list('handoffs')[0],reply=s.list('messages').find(m=>m.direction==='outbound');
 assert.equal(h.requestKind,'live_chat');assert.equal(h.scope,'topic');assert.equal(s.get('conversations',c.id).mode,'auto');
 assert.match(reply.text,/reply here in Instagram/);assert.match(reply.text,/free initial consultation/);assert.equal(reply.consultationOffered,true);assert.equal(s.notifications().items.length,1);
 await s.receive({contactId:c.id,eventId:'human-2',text:'Can I talk to a real person?'});assert.equal(s.notifications().items.length,1);
 await s.humanReply(c.id,{text:'Hi, this is the team. How can I help?'});assert.equal(s.notifications().items.length,0);assert.equal(s.get('handoffs',h.id).status,'resolved');assert.equal(s.get('conversations',c.id).mode,'auto');
});

test('failed human delivery leaves the alert open; taking ownership claims it without resolving technical questions',async t=>{
 const {s,c}=fixture(t);await s.receive({contactId:c.id,eventId:'request',text:'Can I speak to a human?'});
 s.providers.instagram.send=async()=>{throw new Error('uncertain send');};await s.humanReply(c.id,{text:'Team reply'});assert.equal(s.notifications().items.length,1);
 const question=s.handoff(c.id,'Verify the structural detail','normal',{scope:'topic',topicKey:'structure'});
 await s.mode(c.id,{mode:'human'});assert.equal(s.list('handoffs').find(h=>h.requestKind==='live_chat').status,'claimed');assert.equal(s.get('handoffs',question.id).status,'waiting');
});

test('customer record sync includes questionnaire, evidence and bookings, preserving its Drive link during updates',async t=>{
 const {s,c}=fixture(t);await s.receive({contactId:c.id,eventId:'details',text:'location: Seattle; budget: $900k'});
 const p=s.state().contacts[0].project;s.put('projects',{...p,questionnaireAnswers:{land_owned:{value:'yes',author:'customer_form'}}});
 const token=s.customerPages.create(c.id,'booking').url.split('#')[1],slots=await s.customerPages.slots(token);await s.customerPages.book(token,slots.slots[0].id);await s.sync();
 const job=s.get('sync_jobs',`customer-summary-${c.id}`);assert.equal(job.mimeType,'text/plain');assert.match(job.payload,/PROJECT DETAILS/);assert.match(job.payload,/900k/);assert.match(job.payload,/CONVERSATION/);assert.ok(job.payload.includes(slots.slots[0].start));assert.match(job.payload,/land_owned|own land/);
 assert.equal(readFileSync(s.providers.mirror+'/'+job.path,'utf8'),job.payload);assert.equal(s.get('sync_jobs','table-CustomerRecords').payload.length,1);
 s.put('sync_jobs',{...job,fileId:'example-drive-file',status:'synced'});
 assert.match(s.state().contacts[0].driveRecord.url,/example-drive-file/);assert.equal(s.state().insights.all.people[0].driveRecord.url,s.state().contacts[0].driveRecord.url);
 let unblock;const wait=new Promise(r=>unblock=r);s.providers.drive.save=async()=>{await wait;return {status:'synced',fileId:'example-drive-file'};};
 s.saveFacts(c.id,{updates:[{fieldId:'budget',value:'$950k',status:'confirmed'}]});const syncing=s.sync();assert.match(s.state().contacts[0].driveRecord.url,/example-drive-file/);assert.equal(s.state().contacts[0].driveRecord.status,'pending');unblock();await syncing;
 assert.match(s.get('sync_jobs',job.id).payload,/950k/);
});

test('notification endpoint requires workspace authentication',async t=>{
 const {app,s,c}=fixture(t,{WORKSPACE_TOKEN:'workspace-test'});s.handoff(c.id,'Team question');
 assert.equal((await inject(app.handler,'/api/notifications')).status,401);
 const result=await inject(app.handler,'/api/notifications',{headers:{authorization:'Bearer workspace-test'}});assert.equal(result.status,200);assert.equal(result.json().items.length,1);
});
