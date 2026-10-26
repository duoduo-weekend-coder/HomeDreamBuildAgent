// Generate local business-hour slots without depending on the server's timezone.
// Round-trip validation skips nonexistent wall times at DST transitions.
export function calendarSlots(business, now = Date.now()) {
  const zone = business.timezone;
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });
  const parts = timestamp => Object.fromEntries(formatter.formatToParts(new Date(timestamp)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  const current=parts(now), days=business.bookingHorizonDays || 7;
  const slots=[];
  for(let day=1;day<=days;day++) {
    const date=new Date(Date.UTC(current.year,current.month-1,current.day+day));
    if (!(business.meetingWeekdays || [1,2,3,4,5]).includes(date.getUTCDay())) continue;
    for(const time of business.meetingStartTimes || ['10:00','13:00','15:00']) {
      const [hour,minute]=time.split(':').map(Number);
      const wall=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),hour,minute);
      let timestamp=wall;
      for(let i=0;i<3;i++){const p=parts(timestamp);timestamp+=wall-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);}
      const check=parts(timestamp);
      if(check.hour!==hour || check.minute!==minute || check.day!==date.getUTCDate()) continue;
      if(timestamp<=now)continue;
      slots.push({start:new Date(timestamp).toISOString(),end:new Date(timestamp+business.meetingMinutes*60000).toISOString(),timezone:zone});
    }
  }
  return slots.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
}
