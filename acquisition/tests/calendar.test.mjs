import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarSlots } from '../server/acquisition/calendar-slots.mjs';
const config={timezone:'America/Los_Angeles',meetingMinutes:30,meetingStartTimes:['10:00'],meetingWeekdays:[1,2,3,4,5],bookingHorizonDays:7};
test('calendar slots follow local business hours across the daylight-saving boundary',()=>{
  const slots=calendarSlots(config,Date.parse('2026-10-29T12:00:00Z'));
  assert.ok(slots.some(s=>s.start==='2026-10-30T17:00:00.000Z'));
  assert.ok(slots.some(s=>s.start==='2026-11-02T18:00:00.000Z'));
  for(const s of slots)assert.equal(new Date(s.end)-new Date(s.start),30*60000);
});
