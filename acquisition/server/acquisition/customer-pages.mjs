import { serviceAreaStatus } from './policy.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../domain.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const dayKey = (value, zone) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(new Date(value)).map(x=>[x.type,x.value])); return `${p.year}-${p.month}-${p.day}`; };
export function createCustomerPages({ list, get, put, config, env, providers, locked, calendarLock, onBooked, onRescheduled, onRescheduleUncertain, onIntake }) {
  const unresolved = b => ['pending','unknown'].includes(b?.rescheduleAttempt?.status);
  const revision = b => b.revision || 0;
  function attachExisting(s) {
    if(s.kind!=='booking'||s.status!=='open'||s.rescheduleBookingId)return s;
    const existing=list('bookings').filter(b=>b.projectId===s.projectId&&['pending','unknown','confirmed','simulated'].includes(b.status));
    if(!existing.length)return s;
    if(existing.length!==1 || !['confirmed','simulated'].includes(existing[0].status)||unresolved(existing[0]))throw new AppError('The existing appointment needs verification before another change.',409);
    const b=existing[0];
    if(Date.parse(b.end)<=Date.now())throw new AppError('This appointment has already ended. Please ask the team about a new consultation.',409);
    return put('customer_sessions',{...s,rescheduleBookingId:b.id,bookingRevision:revision(b),originalStart:b.start,originalEnd:b.end});
  }
  function rescheduleTarget(s) {
    if(!s.rescheduleBookingId)return null;
    const b=get('bookings',s.rescheduleBookingId);
    if(!b||b.projectId!==s.projectId||b.contactId!==s.contactId||!['confirmed','simulated'].includes(b.status)||unresolved(b))throw new AppError('The appointment needs verification before another change.',409);
    if(revision(b)!==s.bookingRevision||b.start!==s.originalStart||b.end!==s.originalEnd)throw new AppError('Your appointment changed since this page opened. Reopen the calendar from Instagram.',409);
    return b;
  }
  function create(contactId, kind) {
    const conv = get('conversations', contactId), c = get('contacts', contactId);
    if (!conv || c.doNotContact || ['human','paused','awaiting_human'].includes(conv.mode)) throw new AppError('Customer conversation is not available.',409);
    if(serviceAreaStatus(get('projects',conv.projectId),config.get().business).status==='outside_service_area')throw new AppError('This project is outside our current service area. Please continue in Instagram.',409);
    if(serviceAreaStatus(get('projects',conv.projectId),config.get().business).requiresConfirmation)throw new AppError('Please confirm your project location in Instagram first.',409);
    const origin = env.PUBLIC_CUSTOMER_ORIGIN || (providers.modes.instagram === 'mock' ? 'http://localhost:3000' : null);
    if (!origin) throw new AppError('Public customer page is not configured.',503);
    const base = new URL(origin); if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1'].includes(base.hostname))) throw new AppError('Customer pages require HTTPS.');
    const token = randomBytes(32).toString('base64url');
    const session=attachExisting(put('customer_sessions', { id: hash(token), kind, contactId, projectId: conv.projectId, ownershipVersion: conv.ownershipVersion, status:'open', expiresAt:new Date(Date.now()+24*3600000).toISOString(), slots:[] }));
    return { mode:session.rescheduleBookingId?'reschedule':'book', url: `${base.origin}/customer#${token}`, expiresInHours:24 };
  }
  function requireSession(token, kind) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('This link is invalid or expired.',401);
    const s=get('customer_sessions',hash(token));
    if (!s || Date.parse(s.expiresAt)<=Date.now() || (kind && s.kind!==kind)) throw new AppError('This link is invalid or expired.',401);
    const c=get('contacts',s.contactId),conv=get('conversations',s.contactId);
    if (!c || c.doNotContact || conv.projectId!==s.projectId || conv.ownershipVersion!==s.ownershipVersion || ['human','paused','awaiting_human'].includes(conv.mode)) throw new AppError('This link is no longer active. Please return to Instagram.',409);
    if(serviceAreaStatus(get('projects',s.projectId),config.get().business).status==='outside_service_area')throw new AppError('This project is outside our current service area. Please return to Instagram.',409);
    if(serviceAreaStatus(get('projects',s.projectId),config.get().business).requiresConfirmation)throw new AppError('Please confirm your project location in Instagram first.',409);
    return s;
  }
  const summary = b => b ? { status:unresolved(b)?'reschedule_unknown':b.status,start:b.start,end:b.end,timezone:b.timezone,rescheduled:Boolean(b.rescheduleHistory?.length),changeOutcome:b.rescheduleAttempt?.status||null } : null;
  function startReschedule(token){const s=requireSession(token,'booking');if(!s.bookingId)throw new AppError('Open your confirmed appointment before changing its time.',409);return create(s.contactId,'booking');}
  const formQuestions = () => config.get().questionnaire.questions.filter(q => q.formEnabled ?? q.enabled);
  const formSignature = () => hash(JSON.stringify(formQuestions().map(q => [q.id, q.formQuestion || q.question])));
  function session(token) {
    const s=attachExisting(requireSession(token)), business=config.get().business, project=get('projects',s.projectId);
    const result={ kind:s.kind,status:s.status,mode:s.rescheduleBookingId?'reschedule':'book',currentBooking:s.rescheduleBookingId?summary(get('bookings',s.rescheduleBookingId)):null,business:business.name,timezone:business.timezone,durationMinutes:business.meetingMinutes,free:true,simulation:providers.modes.calendar==='mock',booking:s.bookingId?summary(get('bookings',s.bookingId)):null };
    if (s.kind==='intake') {
      const questions=formQuestions();
      const snapshot=Object.fromEntries(questions.map(q=>[q.id,project.questionnaireAnswers?.[q.id]||null]));
      put('customer_sessions',{...s,snapshot,formSignature:formSignature()});
      result.title=config.get().questionnaire.formTitle || 'New Home Client Questionnaire';
      result.questions=questions.map(q=>({id:q.id,number:q.number,question:q.formQuestion||q.question,answer:snapshot[q.id]?.value||null}));
    }
    return result;
  }
  async function slots(token) {
    let s=attachExisting(requireSession(token,'booking'));
    if (s.status!=='open') return {slots:[],days:[],booking:s.bookingId?summary(get('bookings',s.bookingId)):null};
    rescheduleTarget(s);
    const business=config.get().business;
    const available=await providers.calendar.availability(business,list('bookings'),{limit:500});
    s=requireSession(token,'booking');
    if (s.status!=='open') return {slots:[],days:[],booking:s.bookingId?summary(get('bookings',s.bookingId)):null};
    rescheduleTarget(s);
    const date=dayKey(Date.now(),business.timezone),days=[];
    for(let i=1;i<=business.bookingHorizonDays;i++){const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+i);days.push(d.toISOString().slice(0,10));}
    put('customer_sessions',{...s,slots:available,slotsExpireAt:new Date(Date.now()+15*60000).toISOString()});
    return {timezone:business.timezone,days,slots:available.map(slot=>({...slot,date:dayKey(slot.start,business.timezone)})),expiresInMinutes:15};
  }
  async function book(token, slotId) {
    const initial=requireSession(token,'booking');
    return locked(initial.contactId,()=>calendarLock(async()=>{
      const s=requireSession(token,'booking');
      if (s.bookingId) return {booking:summary(get('bookings',s.bookingId))};
      if (s.status!=='open' || Date.parse(s.slotsExpireAt||0)<=Date.now()) throw new AppError('Please refresh the calendar before choosing a time.',409);
      const slot=s.slots.find(x=>x.id===slotId);if(!slot)throw new AppError('Select a time shown on your calendar.',400);
      const target=rescheduleTarget(s);
      if(!target && list('bookings').some(b=>b.projectId===s.projectId&&['pending','unknown','confirmed','simulated'].includes(b.status)))throw new AppError('A booking already exists or needs verification. Please return to Instagram.',409);
      const available=await providers.calendar.availability(config.get().business,list('bookings'),{limit:500});
      requireSession(token,'booking');
      rescheduleTarget(s);
      if(!available.some(x=>x.id===slot.id))throw new AppError('That time is no longer available. Please refresh and choose another.',409);
      if(target){
        const requestKey=`reschedule-${s.id}`;
        const attempt={requestKey,status:'pending',start:slot.start,end:slot.end,timezone:slot.timezone,startedAt:new Date().toISOString(),sessionId:s.id};
        put('bookings',{...target,rescheduleAttempt:attempt});put('customer_sessions',{...s,status:'booking',bookingId:target.id});
        let result;
        try{result=await providers.calendar.reschedule({booking:target,slot,requestKey});}
        catch(error){
          const pending=put('bookings',{...get('bookings',target.id),rescheduleAttempt:{...attempt,status:'unknown',error:error.message}});
          put('customer_sessions',{...get('customer_sessions',s.id),status:'verification_required'});onRescheduleUncertain?.(pending);
          throw new AppError('We could not verify the time change. The team will check the existing appointment; please do not make another booking.',502);
        }
        const updated=put('bookings',{...get('bookings',target.id),...result,start:slot.start,end:slot.end,timezone:slot.timezone,displayTime:new Date(slot.start).toLocaleString('en-US',{timeZone:slot.timezone}),revision:revision(target)+1,rescheduleAttempt:{...attempt,status:'applied'},rescheduleHistory:[...(target.rescheduleHistory||[]),{requestKey,from:{start:target.start,end:target.end},to:{start:slot.start,end:slot.end},at:new Date().toISOString()}]});
        put('customer_sessions',{...get('customer_sessions',s.id),status:'booked'});onRescheduled?.(updated,target);
        return {booking:summary(updated)};
      }
      const requestKey=`calendar-page-${s.id}`, c=get('contacts',s.contactId),project=get('projects',s.projectId);
      let b=put('bookings',{contactId:c.id,projectId:project.id,requestKey,start:slot.start,end:slot.end,timezone:slot.timezone,displayTime:new Date(slot.start).toLocaleString('en-US',{timeZone:slot.timezone}),status:'pending',provider:providers.modes.calendar,attendeeAccepted:false});
      put('customer_sessions',{...s,status:'booking',bookingId:b.id});
      try {
        const result=await providers.calendar.book({slot,contact:c,requestKey,business:config.get().business,summary:JSON.stringify(project.facts)});
        b=put('bookings',{...b,...result});put('customer_sessions',{...get('customer_sessions',s.id),status:'booked'});onBooked(b);
        return {booking:summary(b)};
      } catch(error){put('bookings',{...b,status:'unknown',error:error.message});put('customer_sessions',{...get('customer_sessions',s.id),status:'verification_required'});throw new AppError('We could not confirm the booking result. The team needs to verify it; please do not book again.',502);}
    }));
  }
  async function reconcileReschedule(id) {
    const initial=get('bookings',id);if(!initial)throw new AppError('Booking not found.',404);
    return locked(initial.contactId,()=>calendarLock(async()=>{
      const b=get('bookings',id);if(!unresolved(b))throw new AppError('No unresolved appointment change.',409);
      const result=await providers.calendar.reconcileReschedule(b);
      if(!result)throw new AppError('No verified calendar result.',409);
      const changed=result.start && (Date.parse(result.start)!==Date.parse(b.start)||Date.parse(result.end)!==Date.parse(b.end));
      const {outcome,...fields}=result;
      const updated=put('bookings',{...b,...fields,revision:revision(b)+1,rescheduleAttempt:{...b.rescheduleAttempt,status:outcome,verifiedAt:new Date().toISOString()},...(changed?{rescheduleHistory:[...(b.rescheduleHistory||[]),{requestKey:b.rescheduleAttempt.requestKey,from:{start:b.start,end:b.end},to:{start:result.start,end:result.end},at:new Date().toISOString(),verified:true,outcome}],displayTime:new Date(result.start).toLocaleString('en-US',{timeZone:result.timezone})}:{})});
      const session=get('customer_sessions',b.rescheduleAttempt.sessionId);if(session)put('customer_sessions',{...session,status:'booked'});
      if(changed)onRescheduled?.(updated,b);
      return updated;
    }));
  }
  async function intake(token,updates) {
    const initial=requireSession(token,'intake');
    return locked(initial.contactId,async()=>{
      const s=requireSession(token,'intake');if(s.status==='submitted')return {saved:true};
      if(s.status!=='open'||!s.snapshot||!s.formSignature)throw new AppError('Refresh and open the Yes/No form before submitting.',409);
      if(s.formSignature!==formSignature())throw new AppError('The questionnaire has changed. Refresh the form before submitting.',409);
      const questions=formQuestions(),project=get('projects',s.projectId);
      if(!Array.isArray(updates)||updates.length>questions.length||updates.some(u=>!u||typeof u!=='object')||new Set(updates.map(u=>u.questionId)).size!==updates.length)throw new AppError('Invalid form answers.');
      for(const u of updates){
        if(!questions.some(q=>q.id===u.questionId)||!['yes','no','unknown'].includes(u.value)||Object.keys(u).some(k=>!['questionId','value'].includes(k)))throw new AppError('Use Yes, No or Not sure for a reference question. Share numbers and text in chat.');
        if(JSON.stringify(project.questionnaireAnswers?.[u.questionId]||null)!==JSON.stringify(s.snapshot[u.questionId]||null))throw new AppError('Your answers were updated in chat. Refresh the form to keep the latest answers.',409);
      }
      if(!updates.length)throw new AppError('Choose at least one answer, or return to Instagram to keep chatting.');
      const submittedAt=new Date().toISOString(),answers={...project.questionnaireAnswers};
      for(const u of updates)answers[u.questionId]={value:u.value,author:'customer_form',sourceMessageId:`intake:${s.id}`,updatedAt:submittedAt};
      put('projects',{...project,questionnaireAnswers:answers,intakeSubmittedAt:submittedAt,questionnaireHistory:[...(project.questionnaireHistory||[]),{at:submittedAt,source:`intake:${s.id}`,updates:updates.map(u=>({...u,question:questions.find(q=>q.id===u.questionId).formQuestion||questions.find(q=>q.id===u.questionId).question,previous:project.questionnaireAnswers?.[u.questionId]?.value||null}))}]});
      put('customer_sessions',{...s,status:'submitted',submittedAt:new Date().toISOString()});
      onIntake(s,updates);
      return {saved:true};
    });
  }
  return {create,session,slots,book,intake,startReschedule,reconcileReschedule};
}
