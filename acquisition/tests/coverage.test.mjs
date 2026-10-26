import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.mjs';
import {serviceAreaStatus} from '../server/acquisition/policy.mjs';

function fixture(t,agent){
 const dir=mkdtempSync('/tmp/coverage-'),app=createApp({dataDir:dir,seed:false,env:{},...(agent?{agent}:{})});
 t.after(()=>{app.close();rmSync(dir,{recursive:true,force:true});});const s=app.service,c=s.createContact({handle:'coverage.customer'});
 return {s,c,send:text=>s.receive({contactId:c.id,eventId:randomUUID(),text}),last:()=>s.list('messages').find(m=>m.direction==='outbound')};
}

test('confirmed New York stops qualification even when the model ignores rejected tools',async t=>{
 let blocked=0;
 const agent={mode:'mock',async run(ctx){
  await ctx.call('update_customer_fields',{updates:[{fieldId:'location',value:'New York',status:'confirmed'}]});
  for(const name of ['note_question','offer_short_form','get_intake_form','offer_free_consultation','check_calendar_availability','schedule_followup','request_human_handoff']){
   const r=await ctx.call(name,{fieldId:'square_footage',reason:'continue discovery',hours:12});assert.ok(r.error,name);blocked++;
  }
  return 'Roughly how much space are you planning?';
 }};
 const f=fixture(t,agent);await f.send('New york');await f.send('new york is correct');
 assert.equal(blocked,14);assert.match(f.last().text,/don’t cover projects in New York/);assert.doesNotMatch(f.last().text,/\?|how much|possibly/i);assert.deepEqual(f.last().quickReplies,[]);
 const c=f.s.state().contacts[0];assert.equal(c.signals.fit,'outside_service_area');assert.equal(c.project.stage,'paused');assert.equal(c.conversation.mode,'auto');assert.equal(c.project.lossReason,null);
 assert.equal(f.s.list('customer_sessions').length,0);assert.equal(f.s.list('handoffs').length,0);assert.equal(f.s.list('tasks').filter(t=>t.status==='pending').length,0);
});

test('old form/calendar links and queued follow-ups stop once the project is confirmed outside coverage',async t=>{
 const f=fixture(t);await f.send('Hi');const form=f.s.customerPages.create(f.c.id,'intake').url.split('#')[1],calendar=f.s.customerPages.create(f.c.id,'booking').url.split('#')[1];
 f.s.saveFacts(f.c.id,{updates:[{fieldId:'location',value:'New York',status:'confirmed'}]});
 assert.throws(()=>f.s.customerPages.session(form),/outside our current service area/);await assert.rejects(()=>f.s.customerPages.slots(calendar),/outside our current service area/);
 assert.throws(()=>f.s.customerPages.create(f.c.id,'booking'),/outside our current service area/);
 assert.throws(()=>f.s.scheduleFollowup(f.c.id,{dueAt:new Date(Date.now()+3600000).toISOString(),reason:'Follow up'}),/outside the service area/);
 assert.ok(f.s.list('tasks').every(t=>t.status!=='pending'));assert.equal(f.s.state().contacts[0].project.facts.location.value,'New York');
});

test('a corrected project location resumes discovery without turning the agent off',async t=>{
 const f=fixture(t);await f.send('New York');assert.equal(f.s.state().contacts[0].project.stage,'paused');
 await f.send('The project is actually in Bellevue');const c=f.s.state().contacts[0];
 assert.equal(c.project.facts.location.value,'Bellevue');assert.equal(c.signals.fit,'match');assert.equal(c.conversation.mode,'auto');assert.notEqual(c.project.stage,'paused');assert.equal(c.project.pausedForCoverage,false);assert.doesNotMatch(f.last().text,/don’t cover/);
 assert.ok(f.s.customerPages.create(f.c.id,'intake').url);
});

test('outside-area conversations can still answer questions and explicitly request a team member',async t=>{
 const agent={mode:'mock',async run(ctx){if(ctx.text==='New York')await ctx.call('update_customer_fields',{updates:[{fieldId:'location',value:'New York',status:'confirmed'}]});return 'Our website shows examples of custom homes and additions.';}};
 const f=fixture(t,agent);await f.send('New York');await f.send('Where can I see your past work?');assert.match(f.last().text,/website shows examples/);
 await f.send('Can a human confirm whether an exception is possible?');assert.equal(f.s.list('handoffs').length,1);assert.equal(f.s.state().contacts[0].conversation.mode,'auto');assert.equal(f.last().questionField,null);assert.equal(f.last().consultationOffered,false);
});

test('coverage matching uses configured names and aliases, and uncertain locations remain unconfirmed',()=>{
 const business={serviceAreas:['Seattle','Bellevue'],serviceAreaAliases:{Seattle:['西雅图']}};
 const p=(value,status='confirmed')=>({facts:{location:{value,status}}});
 assert.equal(serviceAreaStatus(p('New York'),business).status,'outside_service_area');assert.equal(serviceAreaStatus(p('NotSeattle'),business).status,'outside_service_area');assert.equal(serviceAreaStatus(p('Seattle, WA'),business).status,'match');assert.equal(serviceAreaStatus(p('西雅图'),business).status,'match');assert.equal(serviceAreaStatus(p('New York','inferred'),business).status,'unknown');
});


test('tentative Seattle is clarified before collecting size and confirmed Seattle resumes normally',async t=>{
 const agent={mode:'mock',async run(ctx){
  const confirmed=ctx.text==='Seattle is confirmed';
  await ctx.call('update_customer_fields',{updates:[{fieldId:'location',value:'Seattle',status:confirmed?'confirmed':'inferred'}]});
  const question=await ctx.call('note_question',{fieldId:'square_footage'});
  assert.equal(Boolean(question.error),!confirmed);
  return 'Roughly how much space are you planning?';
 }};
 const f=fixture(t,agent);await f.send('Yes seattle maybe');assert.equal(f.last().questionField,'location');assert.match(f.last().text,/Seattle.*intended location/);assert.doesNotMatch(f.last().text,/how much space/);assert.equal(f.s.state().contacts[0].project.stage,'paused');assert.throws(()=>f.s.customerPages.create(f.c.id,'booking'),/confirm your project location/);
 await f.send('Seattle is confirmed');assert.equal(f.last().questionField,'square_footage');assert.equal(f.s.state().contacts[0].signals.fit,'match');assert.notEqual(f.s.state().contacts[0].project.stage,'paused');
});
