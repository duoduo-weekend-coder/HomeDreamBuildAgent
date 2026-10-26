import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createApp } from '../server/app.mjs';
import { summarizeAcquisition } from '../server/acquisition/insights.mjs';

function fixture(t) {
  const dataDir=mkdtempSync('/tmp/acquisition-insights-');
  const app=createApp({dataDir,seed:false,env:{DEVELOPER_TEST_RESET_ENABLED:'true',DEVELOPER_TEST_INSTAGRAM_IDS:'test-ig'},agent:{mode:'mock',async run(){return 'Thanks for sharing.';}}});
  t.after(()=>{app.close();rmSync(dataDir,{recursive:true,force:true});});
  return app.service;
}

test('direct DMs, submitted forms and confirmed bookings update insights without any first outreach',async t=>{
  const s=fixture(t),c=s.createContact({handle:'organic.customer'});
  await s.receive({contactId:c.id,eventId:'organic-1',text:'Hello'});
  await s.receive({contactId:c.id,eventId:'organic-2',text:'Seattle'});
  assert.equal(s.state().funnel.total.sent,0);
  assert.equal(s.state().insights.customers.dm,1);
  const token=s.customerPages.create(c.id,'intake').url.split('#')[1];
  s.customerPages.session(token);
  assert.equal(s.state().insights.all.formsSubmitted,0); // An operator preview is not a conversion.
  await s.customerPages.intake(token,[{questionId:'land_owned',value:'yes'}]);await s.tick();
  let stats=s.state().insights.all;
  assert.equal(stats.formsSubmitted,1);assert.equal(stats.discovery,1);assert.equal(stats.dm,1);assert.equal(stats.dmToDiscoveryRate,1);assert.equal(stats.formCompletionRate,null);
  const bookingToken=s.customerPages.create(c.id,'booking').url.split('#')[1],calendar=await s.customerPages.slots(bookingToken);
  await s.customerPages.book(bookingToken,calendar.slots[0].id);
  stats=s.state().insights.all;assert.equal(stats.booked,1);assert.equal(stats.dmToBookingRate,1);assert.equal(stats.replied,1);assert.equal(stats.people[0].meetings[0].start,calendar.slots[0].start);assert.equal(stats.people[0].meetings[0].timezone,calendar.slots[0].timezone);
  const b=s.list('bookings')[0];s.put('bookings',{...b,status:'cancelled'});
  assert.equal(s.state().insights.all.booked,0);
  await s.sync();assert.equal(s.get('sync_jobs','table-AcquisitionInsights').payload.all.formsSubmitted,1);
});

test('developer tests have a separate report and restarting hi excludes all previous-round progress',async t=>{
  const s=fixture(t),c=s.createContact({handle:'tester',instagramId:'test-ig'});
  await s.receive({contactId:c.id,eventId:'first-hi',text:'hi'});
  const p=s.state().contacts[0].project;
  s.put('projects',{...p,intakeSubmittedAt:new Date().toISOString(),questionnaireAnswers:{land_owned:{value:'yes'}}});
  s.put('bookings',{contactId:c.id,projectId:p.id,status:'simulated'});
  assert.equal(s.state().insights.developerTests.formsSubmitted,1);assert.equal(s.state().insights.customers.contacts,0);
  await s.receive({contactId:c.id,eventId:'restart-hi',text:'hi'});
  const stats=s.state().insights;
  assert.equal(stats.developerTests.dm,1);assert.equal(stats.developerTests.formsSubmitted,0);assert.equal(stats.developerTests.booked,0);assert.equal(stats.developerTests.people[0].testRound,2);assert.equal(stats.all.contacts,1);assert.equal(stats.archivedTestRounds,2);
});

test('counts unique people, ignores drafts and unknown bookings, and keeps rate denominators truthful',()=>{
  const stats=summarizeAcquisition({
    contacts:[{id:'a'},{id:'b'},{id:'c'}],
    projects:[{id:'pa',contactId:'a',facts:{},intakeSubmittedAt:'today'},{id:'pb',contactId:'b',facts:{}},{id:'pc',contactId:'c',facts:{},intakeSubmittedAt:'today'}],
    messages:[{contactId:'a',direction:'inbound',author:'customer',status:'received'},{contactId:'a',direction:'inbound',author:'customer',status:'received'},{contactId:'b',direction:'inbound',author:'customer_form',status:'received'},{contactId:'a',direction:'outbound',status:'sent',formOffered:true},{contactId:'a',direction:'outbound',status:'sent',formOffered:true},{contactId:'b',direction:'outbound',status:'sent',formOffered:true},{contactId:'c',direction:'outbound',status:'draft',formOffered:true}],
    comments:[{contactId:'a',private:{status:'sent'}},{contactId:'a',private:{status:'sent'}},{contactId:'b',archivedTest:true},{contactId:'c',private:{status:'send_unknown'}}],
    bookings:[{contactId:'a',projectId:'pa',status:'confirmed'},{contactId:'a',projectId:'pa',status:'confirmed'},{contactId:'b',projectId:'pb',status:'unknown'},{contactId:'c',projectId:'old',status:'confirmed'}]
  }).all;
  assert.equal(stats.dm,1);assert.equal(stats.commenters,2);assert.equal(stats.privateInvitations,1);assert.equal(stats.formOffered,2);assert.equal(stats.formsSubmitted,2);assert.equal(stats.formCompletionRate,.5);assert.equal(stats.booked,1);assert.equal(stats.dmToBookingRate,1);
});
