import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.mjs';
import {createProviders} from '../server/acquisition/providers.mjs';
import {inject} from './http-harness.mjs';

async function fixture(t){
 const dir=mkdtempSync('/tmp/reschedule-'),app=createApp({dataDir:dir,seed:false,env:{}});t.after(()=>{app.close();rmSync(dir,{recursive:true,force:true});});const s=app.service,c=s.createContact({handle:'reschedule.customer'}),send=text=>s.receive({contactId:c.id,eventId:randomUUID(),text});
 await send('Book a meeting');const token=s.list('messages').find(m=>m.direction==='outbound').text.match(/\/customer#([A-Za-z0-9_-]+)/)[1];
 const slots=await s.customerPages.slots(token);await s.customerPages.book(token,slots.slots[0].id);
 return {app,s,c,send,token,original:s.list('bookings')[0]};
}

test('reschedule updates one appointment and its preparation task, with history and idempotent confirmation',async t=>{
 const f=await fixture(t);const task=f.s.list('tasks').find(t=>t.bookingId===f.original.id),bookedAt=f.s.state().contacts[0].project.bookedAt;
 await f.send('Book another time');const message=f.s.list('messages').find(m=>m.direction==='outbound');assert.match(message.text,/current appointment stays/);
 const token=message.text.match(/\/customer#([A-Za-z0-9_-]+)/)[1],session=f.s.customerPages.session(token);assert.equal(session.mode,'reschedule');assert.equal(session.currentBooking.start,f.original.start);
 const slots=await f.s.customerPages.slots(token);assert.equal(f.s.get('bookings',f.original.id).start,f.original.start);const slot=slots.slots[0];
 const result=await f.s.customerPages.book(token,slot.id);assert.equal(result.booking.start,slot.start);assert.equal(result.booking.rescheduled,true);
 const updated=f.s.get('bookings',f.original.id);assert.equal(updated.externalId,f.original.externalId);assert.equal(f.s.list('bookings').length,1);assert.equal(updated.rescheduleHistory.length,1);assert.equal(updated.rescheduleHistory[0].from.start,f.original.start);
 assert.equal(f.s.get('tasks',task.id).dueAt,slot.start);assert.equal(f.s.list('tasks').filter(t=>t.bookingId===updated.id&&t.type==='human').length,1);assert.equal(f.s.state().contacts[0].project.bookedAt,bookedAt);
 await f.s.customerPages.book(token,slots.slots[1].id);assert.equal(f.s.get('bookings',updated.id).start,slot.start);assert.equal(f.s.get('bookings',updated.id).rescheduleHistory.length,1);
 assert.equal(f.s.customerPages.session(f.token).booking.start,slot.start);
});

test('links sent before reschedule support automatically bind to the existing appointment; concurrent stale tabs cannot overwrite',async t=>{
 const f=await fixture(t),a=f.s.customerPages.create(f.c.id,'booking').url.split('#')[1],b=f.s.customerPages.create(f.c.id,'booking').url.split('#')[1];
 const record=f.s.list('customer_sessions').find(s=>s.rescheduleBookingId===f.original.id);f.s.put('customer_sessions',{...record,rescheduleBookingId:null});
 const first=await f.s.customerPages.slots(a),second=await f.s.customerPages.slots(b);assert.equal(f.s.customerPages.session(b).mode,'reschedule');
 await f.s.customerPages.book(a,first.slots[0].id);await assert.rejects(()=>f.s.customerPages.book(b,second.slots[1].id),/appointment changed/);assert.equal(f.s.list('bookings').length,1);
 const response=await inject(f.app.handler,'/api/customer/reschedule',{method:'POST',headers:{authorization:`Bearer ${f.token}`},body:'{}'});assert.equal(response.status,200);assert.equal(response.json().mode,'reschedule');
});

test('conflicting new time and revoked ownership preserve the original appointment without provider writes',async t=>{
 const f=await fixture(t),token=f.s.customerPages.create(f.c.id,'booking').url.split('#')[1],slots=await f.s.customerPages.slots(token);let writes=0;
 f.s.providers.calendar.reschedule=async()=>{writes++;};f.s.providers.calendar.availability=async()=>[];
 await assert.rejects(()=>f.s.customerPages.book(token,slots.slots[0].id),/no longer available/);assert.equal(writes,0);assert.equal(f.s.get('bookings',f.original.id).start,f.original.start);
 await f.s.mode(f.c.id,{mode:'human'});await assert.rejects(()=>f.s.customerPages.book(token,slots.slots[0].id),/no longer active/);
});

test('uncertain updates are not retried; verification repairs time and preparation state',async t=>{
 const f=await fixture(t),token=f.s.customerPages.create(f.c.id,'booking').url.split('#')[1],slots=await f.s.customerPages.slots(token),slot=slots.slots[0];let writes=0;
 f.s.providers.calendar.reschedule=async()=>{writes++;throw new Error('response lost after PATCH');};
 await assert.rejects(()=>f.s.customerPages.book(token,slot.id),/could not verify/);assert.equal((await f.s.customerPages.book(token,slot.id)).booking.status,'reschedule_unknown');assert.equal(writes,1);
 assert.throws(()=>f.s.customerPages.create(f.c.id,'booking'),/verification/);await assert.rejects(()=>f.s.cancelBooking(f.original.id),/pending appointment change/);
 const available=await f.s.providers.calendar.availability(f.s.config.get().business,f.s.list('bookings'),{limit:500});assert.ok(!available.some(s=>s.start===slot.start));
 f.s.providers.calendar.reconcileReschedule=async()=>({status:'simulated',start:slot.start,end:slot.end,timezone:slot.timezone,outcome:'applied'});
 await f.s.reconcileBooking(f.original.id);assert.equal(f.s.get('bookings',f.original.id).start,slot.start);assert.equal(f.s.list('tasks').find(t=>t.bookingId===f.original.id&&t.type==='human').dueAt,slot.start);assert.equal(writes,1);
});

test('Google reschedule patches the same event with version protection and preserves attendees',async t=>{
 const dir=mkdtempSync('/tmp/reschedule-provider-');t.after(()=>rmSync(dir,{recursive:true,force:true}));const originalFetch=globalThis.fetch,requests=[];t.after(()=>globalThis.fetch=originalFetch);
 const old={externalId:'event-one',provider:'google',start:'2026-10-26T17:00:00Z',end:'2026-10-26T17:30:00Z'},slot={start:'2026-10-26T18:00:00Z',end:'2026-10-26T18:30:00Z',timezone:'America/Los_Angeles'};
 globalThis.fetch=async(url,options={})=>{requests.push({url,options});return {ok:true,status:200,json:async()=>options.method==='PATCH'?{id:'event-one',htmlLink:'https://calendar.google.com/event'}:{id:'event-one',etag:'"v1"',start:{dateTime:old.start},end:{dateTime:old.end},attendees:[{email:'customer@example.com'}],extendedProperties:{private:{requestKey:'original'}}}};};
 const p=createProviders({CALENDAR_PROVIDER:'google',GOOGLE_ACCESS_TOKEN:'test'},dir);
 const result=await p.calendar.reschedule({booking:old,slot,requestKey:'change-one'});assert.equal(result.externalId,'event-one');assert.equal(requests.length,2);assert.match(requests[1].url,/events\/event-one\?sendUpdates=all/);assert.equal(requests[1].options.method,'PATCH');assert.equal(requests[1].options.headers['If-Match'],'"v1"');
 const body=JSON.parse(requests[1].options.body);assert.equal(body.attendees,undefined);assert.equal(body.extendedProperties.private.requestKey,'original');assert.equal(body.extendedProperties.private.rescheduleRequestKey,'change-one');assert.equal(body.start.dateTime,slot.start);
});

test('an unrefreshed first-booking tab cannot silently change an appointment created elsewhere',async t=>{
 const dir=mkdtempSync('/tmp/stale-booking-'),app=createApp({dataDir:dir,seed:false,env:{}});t.after(()=>{app.close();rmSync(dir,{recursive:true,force:true});});
 const s=app.service,c=s.createContact({handle:'two.tabs'}),a=s.customerPages.create(c.id,'booking').url.split('#')[1],b=s.customerPages.create(c.id,'booking').url.split('#')[1];
 const first=await s.customerPages.slots(a),second=await s.customerPages.slots(b);await s.customerPages.book(a,first.slots[0].id);
 await assert.rejects(()=>s.customerPages.book(b,second.slots[1].id),/booking already exists/);
 assert.equal(s.list('bookings').length,1);assert.equal(s.list('bookings')[0].start,first.slots[0].start);assert.equal(s.list('bookings')[0].rescheduleHistory,undefined);
});
