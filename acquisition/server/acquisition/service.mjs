import { createWhatsAppNotifications } from './whatsapp-notifications.mjs';
import { customerRecord, customerRecordText } from './customer-records.mjs';
import { classifyIntent, emptyIntent, validateIntent } from './intent.mjs';
import { refusalText } from './safety.mjs';
import { summarizeAcquisition } from './insights.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, requiredText, optionalText, calculateEstimate } from '../domain.mjs';
import { STAGES, MODES, applyFacts, signals, sendEligibility, summarizeFunnel, consultationReadiness, nextField, fieldApplies, serviceAreaStatus } from './policy.mjs';
import { createAgent } from './agent.mjs';
import { createContentTools } from './content.mjs';
import { createCommentWorkflow } from './comments.mjs';
import { makeQuickReplies, resolveQuickReply } from './quick-replies.mjs';
import { createCustomerPages } from './customer-pages.mjs';

const now = () => new Date().toISOString();
const definition = (name, description, properties = {}, required = []) => ({ name, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
const str = { type: 'string' };
export function createAcquisitionService({ store, config, providers, env = {}, dataDir, seed = true, agent: suppliedAgent }) {
  const agent = suppliedAgent || createAgent(env);
  const locks = new Map();
  let calendarLock = Promise.resolve();
  let syncPromise;
  const list = kind => store.list(`acq_${kind}`);
  const get = (kind, id) => store.get(`acq_${kind}`, id);
  const requireRecord = (kind, id) => { const value = get(kind, id); if (!value) throw new AppError('Record not found.', 404); return value; };
  const recordPath = (kind, id) => kind === 'contacts' ? `collected-data/contacts/${id}/profile.json` : kind === 'projects' ? `collected-data/projects/${id}/project.json` : kind === 'assets' ? `source-materials/catalog/${id}.json` : `operations/${kind}/${id}.json`;
  function put(kind, value) {
    const result = store.put(`acq_${kind}`, value);
    store.put('acq_sync_jobs', { id: `${kind}-${result.id}`, kind, recordId: result.id, path: recordPath(kind, result.id), payload: result, revision: randomUUID(), status: 'pending', attempts: 0 });
    return result;
  }
  const teamNotifications=createWhatsAppNotifications({env,list,get,put,active:h=>activeTestRecord(h)&&get('conversations',h.contactId)?.projectId===h.projectId});
  function event(type, detail, entityId) { return put('activity', { type, detail, entityId }); }
  const content = createContentTools({ list, get, put, providers, env });
  const comments = createCommentWorkflow({ list, get, put, createContact, addInteraction, settings, config, env, providers, content, handoff, locked });
  const customerPages = createCustomerPages({ list,get,put,config,env,providers,locked,
    calendarLock: fn => { const run=calendarLock.catch(()=>{}).then(fn);calendarLock=run;return run; },
    onBooked: booking => {
      const p=requireRecord('projects',booking.projectId);
      setStage(put('projects',{...p,bookedAt:now()}),'meeting_booked','Customer confirmed a time on the booking calendar',null,'customer');
      const conv=requireRecord('conversations',booking.contactId);
      if(conv.projectId===booking.projectId){
        markTasksObsolete(booking.contactId,'Consultation booked');cancelDrafts(booking.contactId,'Customer booked on the calendar');
        put('conversations',{...conv,messageVersion:conv.messageVersion+1,offeredSlots:[]});
      }
      put('tasks',{contactId:booking.contactId,projectId:booking.projectId,bookingId:booking.id,type:'human',title:'Prepare for free initial consultation',reason:'Review project details before the meeting',status:'pending',dueAt:booking.start});
      event('meeting_booked','Customer confirmed a time on the calendar',booking.contactId);
    },
    onRescheduled: (booking,previous) => {
      const project=requireRecord('projects',booking.projectId),conv=requireRecord('conversations',booking.contactId);
      setStage(project,'meeting_booked','Customer confirmed a new consultation time',null,'customer');
      if(conv.projectId===booking.projectId){cancelDrafts(booking.contactId,'Consultation rescheduled');markTasksObsolete(booking.contactId,'Consultation rescheduled');put('conversations',{...conv,messageVersion:conv.messageVersion+1,offeredSlots:[]});}
      const tasks=list('tasks').filter(t=>t.contactId===booking.contactId&&t.type==='human'&&['pending','due','human_action'].includes(t.status)&&(t.bookingId===booking.id||(!t.bookingId&&(!t.projectId||t.projectId===booking.projectId)&&t.dueAt===previous.start)));
      for(const task of tasks)put('tasks',{...task,projectId:booking.projectId,bookingId:booking.id,dueAt:booking.start,reason:'Review project details before the rescheduled consultation'});
      if(!tasks.length)put('tasks',{contactId:booking.contactId,projectId:booking.projectId,bookingId:booking.id,type:'human',title:'Prepare for free initial consultation',reason:'Review project details before the rescheduled consultation',status:'pending',dueAt:booking.start});
      for(const task of list('tasks').filter(t=>t.bookingId===booking.id&&t.type==='booking_verification'&&t.status==='pending'))put('tasks',{...task,status:'complete',resolution:'Calendar time verified'});
      event('meeting_rescheduled','Customer confirmed a new time; original calendar event updated',booking.contactId);
    },
    onRescheduleUncertain: booking => {
      if(!list('tasks').some(t=>t.bookingId===booking.id&&t.type==='booking_verification'&&t.status==='pending'))put('tasks',{contactId:booking.contactId,projectId:booking.projectId,bookingId:booking.id,type:'booking_verification',title:'Verify appointment time change',reason:'Calendar update result is uncertain; verify before retrying',status:'pending',dueAt:now()});
    },
    onIntake: (session,updates) => {
      void receive({contactId:session.contactId,eventId:`intake:${session.id}`,text:`Customer submitted the reference Yes/No questionnaire: ${updates.map(u=>`${u.questionId}: ${u.value}`).join('; ')}. Answers are saved. Continue collecting specific project details in chat without repeating these questions.`},true,{preserveReplyWindow:true,formAnswers:updates}).catch(()=>{});
    }
  });
  function outsideArea(project) { return serviceAreaStatus(project,config.get().business).status==='outside_service_area'; }
  function coverageReply(project,text='') {
    const conf=config.get(),coverage=serviceAreaStatus(project,conf.business);
    const template=/[\u3400-\u9fff]/u.test(text)?conf.templates.outsideServiceAreaZh:conf.templates.outsideServiceArea;
    return template.replace('{areas}',conf.business.serviceAreas.join(', ')).replace('{location}',coverage.location);
  }
  function reconcileCoverage(project) {
    const coverage=serviceAreaStatus(project,config.get().business),previous=project.serviceCoverage;
    if(previous?.status===coverage.status && previous?.location===coverage.location && Boolean(previous?.requiresConfirmation)===Boolean(coverage.requiresConfirmation))return project;
    let updated=put('projects',{...project,serviceCoverage:{...coverage,sourceMessageId:project.facts.location?.sourceMessageId||null,reason:coverage.status==='outside_service_area'?'Project is outside the configured service area':coverage.requiresConfirmation?'Project location needs confirmation':null}});
    if(coverage.status==='outside_service_area' || coverage.requiresConfirmation){
      const reason=coverage.requiresConfirmation?'Project location needs confirmation':'Project is outside the service area';
      markTasksObsolete(project.contactId,reason);cancelDrafts(project.contactId,reason);
      if(['prospect','engaged','qualifying','qualified'].includes(updated.stage))updated=setStage(put('projects',{...updated,pausedForCoverage:true}),'paused',reason,project.facts.location?.sourceMessageId);
    }else if(updated.pausedForCoverage && updated.stage==='paused'){
      updated=setStage(put('projects',{...updated,pausedForCoverage:false}),'engaged','Project location updated; service area no longer excludes the project',project.facts.location?.sourceMessageId);
    }
    return updated;
  }

  function settings() { return get('settings', 'workspace') || config.get().defaults; }
  async function locked(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    const promise = previous.catch(() => {}).then(fn); locks.set(key, promise);
    try { return await promise; } finally { if (locks.get(key) === promise) locks.delete(key); }
  }
  async function sync() {
    if (syncPromise) return syncPromise;
    queueTables();
    syncPromise = (async () => {
      const jobs = list('sync_jobs').filter(job => ['pending', 'failed'].includes(job.status) || (providers.modes.drive === 'google' && job.status === 'local_mirror')).slice(0, 150);
      let completed = 0;
      for (const job of jobs) {
        try {
          const result = job.binary ? await providers.drive.saveBinary(job.path, job.sourceFile, job.mimeType) : await providers.drive.save(job.path, job.payload, {mimeType:job.mimeType});
          if (get('sync_jobs', job.id)?.revision === job.revision) store.put('acq_sync_jobs', { ...job, status: result.status, fileId: result.fileId, lastSyncedAt: now(), attempts: job.attempts + 1, error: null });
          completed++;
        } catch (error) {
          if (get('sync_jobs', job.id)?.revision === job.revision) store.put('acq_sync_jobs', { ...job, status: 'failed', attempts: job.attempts + 1, error: error.message });
        }
      }
      return { completed, provider: providers.modes.drive, pending: list('sync_jobs').filter(job => ['pending', 'failed'].includes(job.status)).length };
    })();
    try { return await syncPromise; } finally { syncPromise = null; }
  }
  function createContact(input) {
    const handle = requiredText(input.handle, 'Instagram handle', 100).replace(/^@/, '');
    if (!/^[a-zA-Z0-9_.]+$/.test(handle)) throw new AppError('Use a valid Instagram handle.');
    const instagramId = optionalText(input.instagramId, 100) || null;
    const existing = list('contacts').find(contact => instagramId ? contact.instagramId === instagramId : !contact.instagramId && contact.handle.toLowerCase() === handle.toLowerCase());
    if (existing) return existing;
    return store.transaction(() => {
      const contact = put('contacts', { handle, name: optionalText(input.name, 100) || handle, instagramId, demo: input.demo !== false, email: '', doNotContact: false, outreachStatus: 'not_contacted', source: optionalText(input.source, 100) || 'manual', firstReplyAt: null });
      const project = put('projects', { contactId: contact.id, title: 'Project discovery', facts: {}, factHistory: [], asked: {}, stage: 'prospect', stageHistory: [], owner: 'Intake team', bookingIntent: false, attachments: [], qualifiedAt: null, bookedAt: null, lossReason: null });
      put('conversations', { id: contact.id, contactId: contact.id, projectId: project.id, mode: settings().replyMode, ownershipVersion: 0, messageVersion: 0, lastInboundAt: null, replyWindowUntil: null, lastAskedField: null, offeredSlots: [], summary: 'New Instagram prospect.' });
      event('prospect_created', `@${handle} added from ${contact.source}`, contact.id);
      return contact;
    });
  }
  function isDeveloperTester(contact) {
    return env.DEVELOPER_TEST_RESET_ENABLED === 'true' && Boolean(contact.instagramId) && String(env.DEVELOPER_TEST_INSTAGRAM_IDS || '').split(',').map(id=>id.trim()).filter(Boolean).includes(String(contact.instagramId));
  }
  function activeTestRecord(record) {
    const conv=record.contactId ? get('conversations',record.contactId) : null;
    if (!conv?.developerTestRound) return true;
    if (record.status==='historical') return false;
    if (record.projectId) return record.projectId===conv.projectId;
    if (record.sourceMessageId) return get('messages',record.sourceMessageId)?.projectId===conv.projectId;
    return !record.archivedTest;
  }
  function conversationMessages(id) { return list('messages').filter(message => message.contactId === id && activeTestRecord(message)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.sequence - b.sequence); }
  function resetDeveloperConversation(contact, sourceEventId) {
    const conv=requireRecord('conversations',contact.id), previous=projectFor(contact.id), round=(conv.developerTestRound||0)+1;
    return store.transaction(()=>{
      put('developer_test_runs',{contactId:contact.id,round,sourceEventId,previousProjectId:previous.id,previousContact:contact,previousConversation:conv});
      put('projects',{...previous,archivedTest:true,archivedAt:now()});
      cancelDrafts(contact.id,'Developer test restarted with hi');markTasksObsolete(contact.id,'Developer test restarted');
      for(const task of list('tasks').filter(t=>t.contactId===contact.id&&['pending','due'].includes(t.status)))put('tasks',{...task,status:'cancelled',archivedTest:true,resolution:'Developer test restarted'});
      for(const item of list('handoffs').filter(h=>h.contactId===contact.id&&['waiting','claimed'].includes(h.status)))put('handoffs',{...item,status:'archived_test'});
      for(const job of list('comments').filter(c=>c.contactId===contact.id)) {
        const update={...job,archivedTest:true};if(job.status==='queued')update.status='archived_test';
        for(const channel of ['public','private'])if(job[channel]?.status==='draft')update[channel]={...job[channel],status:'cancelled'};
        put('comments',update);
      }
      const project=put('projects',{contactId:contact.id,title:'Project discovery',facts:{},factHistory:[],asked:{},stage:'prospect',stageHistory:[],owner:'Intake team',bookingIntent:false,attachments:[],qualifiedAt:null,bookedAt:null,lossReason:null,developerTestRound:round});
      put('contacts',{...contact,email:'',doNotContact:false,optOutSource:null,outreachStatus:'not_contacted',firstReplyAt:null,lastInteractionAt:null,commentAcquisition:null,commentIntent:null,source:'Instagram developer test'});
      put('conversations',{id:contact.id,contactId:contact.id,projectId:project.id,mode:'auto',owner:'Developer test',ownershipVersion:conv.ownershipVersion+1,messageVersion:conv.messageVersion,lastInboundAt:null,replyWindowUntil:null,lastAskedField:null,offeredSlots:[],slotsExpireAt:null,sourcePostId:null,lastAssistantMeetingOffer:false,formOfferedAt:null,summary:'New developer test conversation.',developerTestRound:round,developerTestResetAt:now()});
      event('developer_test_reset',`Developer test round ${round} started from hi`,contact.id);
      return project;
    });
  }
  function projectFor(contactId) { const convo = requireRecord('conversations', contactId); return requireRecord('projects', convo.projectId); }
  function setStage(project, stage, reason, sourceMessageId, author = 'agent') {
    if (!STAGES.includes(stage)) throw new AppError('Invalid stage.');
    if (stage === 'lost' && !reason?.trim()) throw new AppError('A concrete reason is required before marking a project lost.');
    if (project.stage === stage) return project;
    return put('projects', { ...project, stage, stageHistory: [...(project.stageHistory || []), { from: project.stage, to: stage, reason, sourceMessageId, author, at: now() }], ...(stage === 'qualified' && !project.qualifiedAt ? { qualifiedAt: now() } : {}), ...(stage === 'lost' ? { lossReason: { reason, sourceMessageId, at: now(), author } } : {}) });
  }
  function markTasksObsolete(contactId, reason) {
    for (const task of list('tasks').filter(task => task.contactId === contactId && task.type === 'followup' && ['pending', 'due'].includes(task.status))) put('tasks', { ...task, status: 'cancelled', resolution: reason });
  }
  function cancelDrafts(contactId, reason) {
    for (const message of list('messages').filter(message => message.contactId === contactId && ['draft', 'pending'].includes(message.status) && message.author !== 'human')) put('messages', { ...message, status: 'cancelled', cancellationReason: reason });
    for (const job of list('outreach').filter(job => job.contactId === contactId && ['draft', 'approved', 'needs_manual_execution'].includes(job.status))) put('outreach', { ...job, status: 'cancelled', error: reason });
  }
  function handoff(contactId, reason, priority = 'normal', options = {}) {
    const scope = options.scope === 'conversation' ? 'conversation' : 'topic';
    const topicKey = options.topicKey || reason;
    const conversation = requireRecord('conversations', contactId);
    const project = projectFor(contactId);
    const current = list('handoffs').find(item => item.contactId === contactId && (item.scope || 'conversation') === scope && (scope === 'conversation' || item.topicKey === topicKey) && ['waiting', 'claimed'].includes(item.status));
    if (current) return current;
    const value = put('handoffs', { contactId, projectId: project.id, reason, priority, scope, topicKey, sourcePostId: conversation.sourcePostId || null, requestKind: options.requestKind || 'question', status: 'waiting', owner: null, summary: { facts: project.facts, missing: config.get().schema.fields.filter(field => !project.facts[field.id]).map(field => field.label), recentMessages: conversationMessages(contactId).slice(-6).map(message => ({ direction: message.direction, text: message.text })), recommendedNextStep: 'Read the current conversation and continue without repeating collected questions.' } });
    if (scope === 'conversation') {
      put('conversations', { ...conversation, mode: 'awaiting_human', ownershipVersion: conversation.ownershipVersion + 1 });
      cancelDrafts(contactId, 'Full conversation handoff requested'); markTasksObsolete(contactId, 'Full conversation handoff requested');
    }
    teamNotifications.enqueue(value);
    event('human_handoff', reason, contactId);
    return value;
  }
  function toolDefinitions(quoteMode) {
    const schema = config.get().schema;
    const definitions = [
      definition('update_customer_fields', 'Persist newly learned project facts. Use customer statements as evidence. Do not invent facts.', { updates: { type: 'array', items: { type: 'object', properties: { fieldId: { type: 'string', enum: schema.fields.map(field => field.id) }, value: str, status: { type: 'string', enum: ['confirmed', 'inferred', 'unknown', 'declined'] } }, required: ['fieldId', 'value', 'status'], additionalProperties: false } } }, ['updates']),
      definition('note_question', 'Record the single checklist question you are about to ask.', { fieldId: { type: 'string', enum: schema.fields.map(field => field.id) } }, ['fieldId']),
      definition('offer_free_consultation', 'Offer a free initial consultation with a team member using Yes / Not now buttons. This does not book or check times.'),
      definition('offer_short_form', 'Offer an optional one-minute project form once, with Yes / Keep chatting buttons. Do not send the form link until accepted.'),
      definition('get_intake_form', 'Get the optional short-form link only after the customer asks for or accepts the form.'),
      definition('ask_reference_question', 'Ask ONE relevant optional yes/no question from the reference questionnaire, with clickable buttons. Never run the full questionnaire or ask an answered question. Do not also ask a checklist question in this turn.', { questionId: { type: 'string', enum: config.get().questionnaire.questions.filter(q=>q.enabled).map(q=>q.id) } }, ['questionId']),
      definition('search_business_knowledge', 'Look up verified company services, areas and process.', { query: str }, ['query']),
      definition('get_post_context', 'Resolve the exact original Instagram post, video metadata, segment timeline, verified facts and raw-data provenance. Always call before answering questions about a post. Never copy reference-project facts into customer requirements.', { postId: str }),
      definition('inspect_video_segment', 'Inspect relevant video frames before escalating an unanswered question. Uses supplied keyframes or extracts frames directly from the original video when metadata is missing. segmentId is optional for videos without a segment map. Use exact verified metadata for materials, dimensions, prices; never infer those from pixels.', { postId: str, segmentId: str, atSeconds: { type: 'number', minimum: 0 }, question: str }, ['postId', 'question']),
      definition('search_project_media', 'Search the approved reference library. Never access customer attachments.', { query: str }, ['query']),
      definition('send_project_media', 'Attach at most two approved references to your next reply.', { assetIds: { type: 'array', items: str, maxItems: 2 } }, ['assetIds']),
      definition('check_calendar_availability', 'Check consultation availability and offer actual returned slots.'),
      definition('book_meeting', 'Book only a slot explicitly selected by the customer from the latest offer.', { slotId: str }, ['slotId']),
      definition('request_human_handoff', 'Escalate a specific unresolved question while the assistant continues answering and booking. Only use conversation scope if the customer explicitly requests that automation stop.', { reason: str, topicKey: str, scope: { type: 'string', enum: ['topic', 'conversation'] }, priority: { type: 'string', enum: ['normal', 'high'] } }, ['reason']),
      definition('schedule_followup', 'Create a follow-up task. Sending is rechecked when due.', { reason: str, hours: { type: 'number', minimum: 1, maximum: 168 } }, ['reason', 'hours'])
    ];
    if (quoteMode !== 'off') definitions.push(definition('get_project_estimate', 'Request an owner-approved estimate. May be unavailable or require human review. Never invent a replacement price.'));
    return definitions;
  }
  async function reconcileEchoes() {
    for (const record of list('echoes').filter(e=>e.status==='queued')) {
      if (get('echoes',record.id)?.status!=='queued') continue;
      const own=list('messages').some(m=>m.externalId===record.externalId) || list('comments').some(c=>c.private?.externalId===record.externalId);
      if (own) { put('echoes',{...record,status:'matched'});continue; }
      const sending=list('messages').some(m=>m.contactId===record.contactId&&m.status==='sending') || list('comments').some(c=>c.contactId===record.contactId&&c.private?.status==='sending');
      if (sending) continue;
      put('echoes',{...record,status:'native_reply'});
      await mode(record.contactId,{mode:'human',owner:'Instagram native inbox'}).catch(()=>{});
    }
  }
  async function receiveEcho(externalId, recipientId) {
    const contact=list('contacts').find(c=>c.instagramId===String(recipientId));if(!contact)return;
    const id=createHash('sha256').update(`echo:${externalId}`).digest('hex');
    if(get('echoes',id))return;
    put('echoes',{id,externalId,contactId:contact.id,status:'queued'});
    await reconcileEchoes();
  }
  async function sendMessage(message, purpose = 'reply', human = false) {
    const contact = requireRecord('contacts', message.contactId);
    const conversation = requireRecord('conversations', message.contactId);
    const check = human ? { allowed: !contact.doNotContact && Date.parse(conversation.replyWindowUntil || 0) > Date.now(), reason: 'Customer contact or API window is restricted.' } : sendEligibility(contact, conversation, Date.now(), purpose);
    if (!check.allowed) return put('messages', { ...message, status: 'blocked', error: check.reason });
    if (!human && purpose !== 'handoff_notice' && message.replyToVersion !== conversation.messageVersion) return put('messages', { ...message, status: 'cancelled', error: 'A newer customer message superseded this reply.' });
    if(!human && outsideArea(projectFor(message.contactId)) && (message.questionField || message.referenceQuestion || message.formOffered || message.consultationOffered || /\/customer#/.test(message.text)))return put('messages',{...message,status:'cancelled',error:'Project is outside the service area; qualification and invitations are paused.'});
    put('messages', { ...message, status: 'sending' });
    try {
      const result = await providers.instagram.send({ contact, text: message.text, media: message.media, quickReplies: message.quickReplies });
      if (['sent', 'simulated_sent'].includes(result.status)) {
        const current = requireRecord('conversations', message.contactId);
        if (current.messageVersion === message.replyToVersion) {
          put('conversations', { ...current, ...(message.questionField ? { lastAskedField: message.questionField } : {}), ...(message.formOffered ? {formOfferedAt:now()} : {}), lastAssistantMeetingOffer: message.author === 'agent' && Boolean(message.consultationOffered) });
          if (message.questionField) { const project = projectFor(message.contactId); put('projects', { ...project, asked: { ...project.asked, [message.questionField]: now() } }); }
        }
      }
      if((message.coverageNotice || message.locationConfirmation) && ['sent','simulated_sent'].includes(result.status)){const p=projectFor(message.contactId);if(p.id===message.projectId && p.serviceCoverage)put('projects',{...p,serviceCoverage:{...p.serviceCoverage,...(message.coverageNotice?{noticeSentAt:now()}:{confirmationAskedAt:now()})}});}
      const saved=put('messages', { ...message, ...result, sentAt: now() });
      await reconcileEchoes();return saved;
    } catch (error) { const saved=put('messages', { ...message, status: 'send_unknown', error: error.message });await reconcileEchoes();return saved; }
  }

  async function runEvent(eventId) {
    const inbound = requireRecord('inbound_events', eventId);
    return locked(inbound.contactId, async () => {
      let conversation = requireRecord('conversations', inbound.contactId);
      if (['complete', 'superseded'].includes(requireRecord('inbound_events', eventId).status)) return;
      if (inbound.version !== conversation.messageVersion) { put('inbound_events', { ...inbound, status: 'superseded' }); return; }
      put('inbound_events', { ...inbound, status: 'processing' });
      const text = inbound.text;
      let selectedMedia = [];
      let questionField = null;
      let referenceQuestion = null, consultationOffered = false, offeredThisTurn = null, formOffered = false, customerLink = null, coverageBlocked = false, coverageNotice = false, locationConfirmation = false;
      let agentHandoff = false;
      let intent=emptyIntent();
      try{
        const choice=inbound.quickReply;
        if(!inbound.formSubmission&&!inbound.developerTestReset){
          intent=inbound.intent?.disposition ? validateIntent(inbound.intent) : await classifyIntent({env,text:get('messages',inbound.messageId)?.text||text,messages:conversationMessages(inbound.contactId),project:projectFor(inbound.contactId),conversation,safetyPolicy:config.get().safety,recordUsage:usage=>put('usage',{contactId:inbound.contactId,sourceMessageId:inbound.messageId,provider:'claude',purpose:'intent',usage})});
          if(intent.disposition==='in_scope' && choice && !choice.invalid && (choice.type!=='intent'||choice.intentValue)){
            if(choice.type==='form')intent.form=choice.value==='yes'?'request':'decline';
            if(choice.type==='consultation'||choice.type==='questionnaire'&&choice.questionId==='specialist_call')intent.booking=choice.value==='yes'?'book':'none';
            if(choice.type==='slot')intent.slotId=choice.slotId;
            if(choice.type==='intent'){intent.projectInterest=choice.intentValue==='project';intent.browsingOnly=choice.intentValue==='browsing';}
          }
        }
      }catch{
        intent={...emptyIntent(),disposition:'unverified'};
        inbound.safetyError='Safety assessment unavailable or invalid; no business action taken.';
      }
      const current=get('conversations',inbound.contactId);if(current.messageVersion!==inbound.version||current.ownershipVersion!==conversation.ownershipVersion){put('inbound_events',{...inbound,status:'superseded'});return;}
      put('inbound_events',{...get('inbound_events',eventId),intent,...(inbound.safetyError?{safetyError:inbound.safetyError}:{})});
      inbound.intent=intent;
      const assessedMessage=get('messages',inbound.messageId);if(assessedMessage)put('messages',{...assessedMessage,intent});
      if(intent.disposition!=='in_scope' && !intent.optOut){
        const contact=requireRecord('contacts',inbound.contactId),fresh=requireRecord('conversations',inbound.contactId);
        if(!contact.doNotContact && ['auto','review'].includes(fresh.mode)){
          const message=put('messages',{id:`reply-${inbound.id}`,contactId:contact.id,projectId:inbound.projectId||fresh.projectId,direction:'outbound',author:'agent',text:refusalText(intent.disposition,config.get().safety),media:[],quickReplies:[],replyToVersion:inbound.version,sourceMessageId:inbound.messageId,sequence:Date.now(),status:fresh.mode==='review'?'draft':'pending',purpose:'reply',safetyRefusal:intent.disposition});
          if(fresh.mode==='auto')await sendMessage(message);
        }
        event('message_refused',`Request declined: ${intent.disposition}`,inbound.contactId);
        put('inbound_events',{...inbound,status:'complete',error:null,processedAt:now()});
        return;
      }
      if(intent.disposition==='in_scope' && inbound.quickReply && !inbound.quickReply.invalid){
        const choice=inbound.quickReply;let p=projectFor(inbound.contactId);
        if(choice.type==='field')p=put('projects',applyFacts(p,[{fieldId:choice.fieldId,value:choice.value,status:choice.status}],config.get().schema,inbound.messageId,'customer_button'));
        if(choice.type==='questionnaire'){
          p=put('projects',{...p,questionnaireAnswers:{...p.questionnaireAnswers,[choice.questionId]:{value:choice.value,sourceMessageId:inbound.messageId,updatedAt:now()}}});
          if(choice.questionId==='blueprints')put('projects',applyFacts(p,[{fieldId:'blueprints',value:choice.value==='yes'?'available':choice.value==='no'?'not_yet':'unknown',status:choice.value==='unknown'?'unknown':'confirmed'}],config.get().schema,inbound.messageId,'customer_button'));
        }
      }
      const rescheduleRequested=intent.booking==='reschedule';
      const bookingRequested=intent.booking!=='none';
      const selectedId=inbound.quickReply?.type==='slot'?inbound.quickReply.slotId:intent.slotId;
      const chosenSlot=!inbound.quickReply?.invalid && selectedId && Date.parse(conversation.slotsExpireAt||0)>Date.now() && conversation.offeredSlots?.some(s=>s.id===selectedId)?selectedId:null;
      const formRequested=intent.form==='request';
      const explicitHuman=intent.human!=='none';
      const declinedConsultation = inbound.formSubmission && inbound.formAnswers?.some(a=>a.questionId==='specialist_call'&&a.value!=='yes');
      const mayInvite = () => !serviceAreaStatus(projectFor(inbound.contactId),config.get().business).requiresConfirmation && !outsideArea(projectFor(inbound.contactId)) && !declinedConsultation && (bookingRequested || explicitHuman || consultationReadiness(projectFor(inbound.contactId),config.get().schema).allowed);
      const expectedOwnership = conversation.ownershipVersion;
      const quoteMode = settings().quoteMode;
      let project = reconcileCoverage(projectFor(inbound.contactId));
      if(intent.projectInterest)project=put('projects',{...project,acquisitionIntent:{projectInterest:true,sourceMessageId:inbound.messageId}});
      if (bookingRequested && !outsideArea(project) && !project.bookingIntent) project = put('projects', { ...project, bookingIntent: true, bookingIntentSource: inbound.messageId });
      function snapshot() { return { contact: requireRecord('contacts', inbound.contactId), conversation: requireRecord('conversations', inbound.contactId), project: projectFor(inbound.contactId), messages: conversationMessages(inbound.contactId), quickReply: inbound.quickReply, formSubmission: inbound.formSubmission, formAnswers: inbound.formAnswers, appointments:list('bookings').filter(b=>b.projectId===projectFor(inbound.contactId).id).map(b=>({status:b.status,start:b.start,end:b.end,timezone:b.timezone,changeStatus:b.rescheduleAttempt?.status||null})), serviceCoverage: serviceAreaStatus(projectFor(inbound.contactId),config.get().business), nextDiscoveryField: outsideArea(projectFor(inbound.contactId))?null:nextField(projectFor(inbound.contactId),config.get().schema), bookingRequested, rescheduleRequested, intent, formRequested, consultationReadiness: consultationReadiness(projectFor(inbound.contactId),config.get().schema), confirmedSlotId: chosenSlot, sourcePostId: inbound.sourcePostId || requireRecord('conversations', inbound.contactId).sourcePostId || null, acquisitionComment: (() => { const id = get('contacts', inbound.contactId).commentAcquisition?.commentId; const c = id ? get('comments', id) : null; return c ? { id: c.id, text: c.text, mediaId: c.mediaId } : null; })(), openQuestions: list('handoffs').filter(h => h.contactId === inbound.contactId && activeTestRecord(h) && h.scope === 'topic' && ['waiting', 'claimed'].includes(h.status)).map(h => ({ id: h.id, reason: h.reason, topicKey: h.topicKey, status: h.status })), teamAnswers: list('handoffs').filter(h => h.contactId === inbound.contactId && activeTestRecord(h) && h.scope === 'topic' && h.status === 'resolved').slice(0,8).map(h => ({ question: h.reason, answer: h.answer, sourcePostId: h.sourcePostId, sentToCustomer: Boolean(h.answerMessageId) })) }; }
      async function call(name, input = {}) {
        const start = now(); let result;
        try {
          if(intent.disposition!=='in_scope')throw new AppError('Business tools are unavailable for this request.',403);
          const latest = snapshot();
          if (latest.contact.doNotContact || latest.conversation.messageVersion !== inbound.version || latest.conversation.ownershipVersion !== expectedOwnership) throw new AppError('Conversation ownership or customer message changed; do not execute another action.', 409);
          if (!toolDefinitions(settings().quoteMode).some(tool => tool.name === name)) throw new AppError('Tool is disabled or unavailable.', 403);
          if(serviceAreaStatus(latest.project,config.get().business).requiresConfirmation && (name==='note_question' && input.fieldId!=='location' || ['ask_reference_question','offer_short_form','get_intake_form','offer_free_consultation','check_calendar_availability','book_meeting','schedule_followup'].includes(name))){
            coverageBlocked=true;throw new AppError('The proposed project location is still inferred. Confirm the project location before further qualification or invitations.');
          }
          if(outsideArea(latest.project) && ['note_question','ask_reference_question','offer_short_form','get_intake_form','offer_free_consultation','check_calendar_availability','book_meeting','schedule_followup','get_project_estimate'].includes(name)){
            coverageBlocked=true;throw new AppError('Project is outside the service area. Explain current coverage and stop qualification or automatic invitations. Do not ask the customer to reconfirm an already confirmed location.');
          }
          if(outsideArea(latest.project) && name==='request_human_handoff' && !explicitHuman)throw new AppError('Do not route an outside-area project to the team unless the customer asks.');
          if (name === 'update_customer_fields') {
            if (inbound.formSubmission) throw new AppError('Reference Yes/No answers are already saved separately. Collect exact project facts in chat; do not infer them from the questionnaire.');
            const updated = reconcileCoverage(put('projects', applyFacts(latest.project, input.updates, config.get().schema, inbound.messageId)));
            const count = Object.values(updated.facts).filter(fact => fact.status === 'confirmed').length;
            if (!['meeting_booked', 'won', 'lost', 'paused', 'human_followup'].includes(updated.stage)) setStage(updated, count >= 3 ? 'qualified' : 'qualifying', 'Project information supplied in conversation', inbound.messageId);
            result = { saved: input.updates.map(patch => patch.fieldId), sourceMessageId: inbound.messageId, serviceCoverage: serviceAreaStatus(updated,config.get().business), ...(outsideArea(updated)?{instruction:'Explain that this project is outside current coverage. Stop project questions and automatic invitations.'}:{}) };
          } else if (name === 'note_question') {
            const field=config.get().schema.fields.find(field => field.id === input.fieldId);
            if (!field) throw new AppError('Unknown checklist field.');
            if (!fieldApplies(field,latest.project) || latest.project.questionnaireAnswers?.[field.answeredByQuestionnaire]) throw new AppError('This question is not relevant to the saved form answers, or has already been answered. Choose another relevant field.');
            questionField = input.fieldId;
            referenceQuestion = null; consultationOffered = false;
            result = { recorded: input.fieldId, sent: false, instruction: 'Include this question in your customer-visible reply. It has not been asked yet.' };
          } else if (name === 'offer_free_consultation') {
            if (!mayInvite()) throw new AppError('Continue discovery first. Missing discussed fields: '+consultationReadiness(latest.project,config.get().schema).missing.join(', '));
            consultationOffered = true; questionField = null; referenceQuestion = null;
            result = { free: true, scope: 'Initial consultation with a team member only', buttons: ['Yes, free consult', 'Not now'], sent: false, instruction: 'Ask whether they would like a free initial consultation. Do not ask another question.' };
          } else if (name === 'offer_short_form') {
            if (latest.conversation.formOfferedAt || latest.project.intakeSubmittedAt) throw new AppError('The form was already offered. Continue the conversation.');
            formOffered=true;questionField=null;referenceQuestion=null;consultationOffered=false;
            result={sent:false,question:config.get().templates.shortFormOffer,buttons:['Yes, short form','Keep chatting']};
          } else if (name === 'get_intake_form') {
            if (!formRequested) throw new AppError('First ask whether the customer wants the optional form.');
            customerLink=customerPages.create(inbound.contactId,'intake');result={...customerLink,kind:'intake',optional:true};
          } else if (name === 'ask_reference_question') {
            const q = config.get().questionnaire.questions.find(q=>q.id === input.questionId && q.enabled);
            if (q?.id === 'specialist_call' && !mayInvite()) throw new AppError('Continue collecting core project information before inviting a consultation.');
            if (!q || latest.project.questionnaireAnswers?.[q.id]) throw new AppError('Reference question is unavailable or already answered.');
            referenceQuestion = q.id; questionField = null; consultationOffered = false;
            result = { question: q.question, buttons: ['Yes','No','Not sure yet'], sent: false, instruction: 'Ask only this question in the customer language. Buttons will be attached automatically.' };
          } else if (name === 'get_post_context') result = content.read(input.postId || latest.sourcePostId, settings().quoteMode);
          else if (name === 'inspect_video_segment') result = await content.inspect(input, settings().quoteMode);
          else if (name === 'search_business_knowledge') result = { summary: `${config.get().business.name} helps with ${config.get().business.services.join(', ')} in ${config.get().business.serviceAreas.join(', ')}.`, knowledge: config.get().business.knowledge, website: config.get().business.website };
          else if (name === 'search_project_media') {
            const words = String(input.query || '').toLowerCase().split(/\W+/).filter(word => word.length > 3);
            result = { assets: list('assets').filter(asset => asset.approved && (providers.modes.instagram === 'mock' || !asset.demo)).map(asset => ({ ...asset, score: words.filter(word => `${asset.title} ${asset.tags.join(' ')}`.toLowerCase().includes(word)).length })).sort((a, b) => b.score - a.score).slice(0, 4) };
          } else if (name === 'send_project_media') {
            if (!Array.isArray(input.assetIds) || !input.assetIds.length || input.assetIds.length > 2) throw new AppError('Choose one or two references.');
            selectedMedia = input.assetIds.map(id => { const asset = requireRecord('assets', id); if (!asset.approved || (asset.demo && providers.modes.instagram !== 'mock')) throw new AppError('This asset is not approved for this channel.', 403); return { id: asset.id, title: asset.title, url: asset.url, demo: asset.demo }; });
            result = { status: 'attached_to_pending_reply', count: selectedMedia.length, sent: false };
          } else if (name === 'check_calendar_availability') {
            if (inbound.quickReply?.type === 'consultation' && inbound.quickReply.value === 'no') throw new AppError('Customer declined this consultation offer. Continue helping without showing times.');
            if (!bookingRequested && !chosenSlot) throw new AppError('Only open the calendar after the customer asks or accepts a consultation.');
            if (env.CALENDAR_UI !== 'text' || rescheduleRequested) {
              customerLink=customerPages.create(inbound.contactId,'booking');
              result={bookingUrl:customerLink.url,mode:customerLink.mode,timezone:config.get().business.timezone,free:true,instruction:'Send this calendar link. It shows real available dates and times. Do not list slots or ask for A/B/C. Nothing is booked until they confirm on the calendar.'};
              put('conversations',{...latest.conversation,offeredSlots:[],slotsExpireAt:null});
            } else {
            const slots = (await providers.calendar.availability(config.get().business, list('bookings'))).map(slot => ({ ...slot, label: new Date(slot.start).toLocaleString('en-US', { timeZone: slot.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }));
            put('conversations', { ...latest.conversation, offeredSlots: slots, slotsExpireAt: new Date(Date.now() + 15 * 60000).toISOString() });
            offeredThisTurn = slots;
            result = { slots, simulated: providers.modes.calendar === 'mock' };
            }
          } else if (name === 'book_meeting') {
            if (!chosenSlot || input.slotId !== chosenSlot) throw new AppError('Customer must explicitly select one of the offered slots.', 409);
            const run = calendarLock.catch(() => {}).then(async () => {
              const fresh = snapshot();
              if (fresh.conversation.ownershipVersion !== expectedOwnership) throw new AppError('Human takeover interrupted booking.', 409);
              const requestKey = `meeting-${inbound.messageId}-${chosenSlot}`;
              const existing = list('bookings').find(booking => booking.requestKey === requestKey);
              if (existing) { if (['pending', 'unknown'].includes(existing.status)) throw new AppError('Previous booking result needs reconciliation; do not retry.', 409); return existing; }
              const priorBooking = list('bookings').find(b => b.projectId === fresh.project.id && ['confirmed', 'simulated', 'unknown', 'pending'].includes(b.status));
              if (priorBooking) throw new AppError('This project already has a meeting or an unresolved booking. Review it before booking again.', 409);
              const slot = fresh.conversation.offeredSlots.find(slot => slot.id === chosenSlot);
              if (!slot || Date.parse(fresh.conversation.slotsExpireAt || 0) <= Date.now()) throw new AppError('This slot offer expired. Check availability again.', 409);
              const available = await providers.calendar.availability(config.get().business, list('bookings'));
              if (!available.some(item => item.id === slot.id)) throw new AppError('This time is no longer available.');
              if (snapshot().conversation.ownershipVersion !== expectedOwnership || snapshot().conversation.messageVersion !== inbound.version || snapshot().contact.doNotContact) throw new AppError('Conversation changed while checking availability.', 409);
              let booking = put('bookings', { contactId: inbound.contactId, projectId: fresh.project.id, requestKey, start: slot.start, end: slot.end, timezone: slot.timezone, displayTime: slot.label, status: 'pending', provider: providers.modes.calendar, attendeeAccepted: false });
              try {
                const result = await providers.calendar.book({ slot, contact: fresh.contact, requestKey, business: config.get().business, summary: JSON.stringify(fresh.project.facts) });
                booking = put('bookings', { ...booking, ...result });
                const p = projectFor(inbound.contactId);
                setStage(put('projects', { ...p, bookedAt: now() }), 'meeting_booked', 'Customer selected an offered consultation time', inbound.messageId);
                markTasksObsolete(inbound.contactId, 'Consultation booked');
                put('tasks', { contactId: inbound.contactId, type: 'human', title: 'Prepare for project consultation', reason: 'Review project facts before the meeting', status: 'pending', dueAt: slot.start });
                event('meeting_booked', `${fresh.contact.name}: ${slot.label}${result.status === 'simulated' ? ' (demo)' : ''}`, inbound.contactId);
                return booking;
              } catch (error) { put('bookings', { ...booking, status: 'unknown', error: error.message }); throw error; }
            }); calendarLock = run; result = await run;
          } else if (name === 'request_human_handoff') {
            if (input.scope === 'conversation' && intent.human!=='exclusive') throw new AppError('Escalate only the question unless the customer explicitly asks automation to stop.');
            result = handoff(inbound.contactId, requiredText(input.reason, 'Handoff reason', 500), input.priority === 'high' ? 'high' : 'normal', { scope: input.scope, topicKey: input.topicKey }); agentHandoff = result.scope === 'conversation';
          }
          else if (name === 'schedule_followup') {
            const hours = Number(input.hours);
            if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new AppError('Follow-up must be between 1 and 168 hours.');
            const existing = list('tasks').find(task => task.contactId === inbound.contactId && task.type === 'followup' && task.status === 'pending');
            result = existing || put('tasks', { contactId: inbound.contactId, type: 'followup', title: 'Follow up on project conversation', reason: requiredText(input.reason, 'Reason', 500), dueAt: new Date(Date.now() + hours * 3600000).toISOString(), status: 'pending', inboundVersion: latest.conversation.messageVersion });
          } else if (name === 'get_project_estimate') {
            const pricing = JSON.parse(readFileSync(path.join(config.directory, 'pricing.json'), 'utf8'));
            if (pricing.mode !== 'approved') throw new AppError('Company-approved pricing is not available. Do not substitute demo rates.', 409);
            const p = latest.project;
            const area = p.facts.square_footage?.value.match(/([\d,]+)\s*(?:sqft|sq\s*ft|square feet)/i)?.[1];
            const location = p.facts.location?.value;
            if (!area || !location || !p.quoteInputs) throw new AppError('Estimator needs reviewed area, location, project type, finish and site inputs.', 409);
            const estimate = calculateEstimate({ ...p.quoteInputs, city: location, areaSqft: Number(area.replaceAll(',', '')) }, pricing);
            const quote = put('quotes', { contactId: inbound.contactId, projectId: p.id, estimate, status: settings().quoteMode === 'review_required' ? 'review_required' : 'ready', sourceMessageId: inbound.messageId });
            result = quote.status === 'review_required' ? { id: quote.id, status: quote.status, requiresHumanReview: true } : quote;
          }
          else throw new AppError('Unknown tool.');
        } catch (error) { result = { error: error.message }; }
        put('tool_runs', { contactId: inbound.contactId, sourceMessageId: inbound.messageId, name, input, result, status: result.error ? 'failed' : 'succeeded', startedAt: start });
        return result;
      }
      try {
        const contact = requireRecord('contacts', inbound.contactId);
        const stop = intent.optOut;
        if (stop) {
          put('contacts', { ...contact, doNotContact: true, optOutSource: inbound.messageId });
          put('conversations', { ...conversation, mode: 'paused', ownershipVersion: conversation.ownershipVersion + 1 });
          cancelDrafts(contact.id, 'Customer opted out'); markTasksObsolete(contact.id, 'Customer opted out');
          event('opt_out', `@${contact.handle} requested no further contact`, contact.id);
        } else if (contact.doNotContact || ['human', 'paused', 'awaiting_human'].includes(conversation.mode)) {
          event('human_message_received', 'New message saved for the assigned person; automation remains paused', contact.id);
        } else {
          let reply;
          let purpose = 'reply';
          if (inbound.developerTestReset) {
            reply=config.get().templates.intro;
          } else if (inbound.quickReply?.invalid) {
            reply = /[\u3400-\u9fff]/u.test(text) ? '这个选项来自之前的问题，已经过期。请使用最新消息里的选项，或直接回复文字。' : 'That option is from an earlier question. Please use the choices in my latest message, or reply in your own words.';
          } else if (inbound.formSubmission) {
            const field=outsideArea(projectFor(contact.id))?null:nextField(projectFor(contact.id),config.get().schema);
            questionField=field?.id||null;
            reply='Thanks — I’ve saved your answers.'+(field?' '+field.question:' We can keep chatting here whenever you have a question.');
          } else if (rescheduleRequested && !explicitHuman) {
            const result=await call('check_calendar_availability',{});
            reply=result.error?result.error:'Choose a new time on the calendar. Your current appointment stays in place until you confirm.';
          } else if (formRequested && !explicitHuman) {
            const result=await call('get_intake_form',{});
            reply=result.error?'The form is temporarily unavailable, but we can continue here.':'Here is your optional project form.';
          } else if (explicitHuman || intent.commercialCommitment) {
            const full = intent.human==='exclusive';
            handoff(contact.id, explicitHuman ? 'Customer asked to speak with a team member in Instagram' : 'Customer requested a commercial commitment', 'high', { scope: full ? 'conversation' : 'topic', topicKey: explicitHuman ? 'live-chat-request' : 'team-request', requestKind: explicitHuman ? 'live_chat' : 'question' });
            reply = full ? 'I’ve added your request to the team’s inbox so someone can reply here. Automated replies are paused; an immediate response is not guaranteed.' : explicitHuman ? config.get().templates.liveChatHandoff : config.get().templates.handoff; purpose = full ? 'handoff_notice' : 'reply';
            consultationOffered = !full && mayInvite();
            if (!full && !consultationOffered) { const f=outsideArea(projectFor(contact.id))?null:nextField(projectFor(contact.id),config.get().schema);questionField=explicitHuman?null:f?.id||null;reply=(explicitHuman ? config.get().templates.liveChatWaiting : config.get().templates.handoffInternal)+(f&&!explicitHuman?' '+f.question:''); }
          } else if (intent.lostReason) {
            setStage(projectFor(contact.id), 'lost', intent.lostReason, inbound.messageId);
            put('conversations', { ...requireRecord('conversations', contact.id), mode: 'paused' });
            markTasksObsolete(contact.id, 'Customer chose another provider');
            reply = null;
          } else reply = await agent.run({ config: config.get(), text, call, snapshot, quoteMode, tools: toolDefinitions(quoteMode), recordUsage: usage => put('usage', { contactId: contact.id, sourceMessageId: inbound.messageId, provider: 'claude', usage }) });
          if (reply) {
            const currentProject=projectFor(contact.id), currentConversation=requireRecord('conversations',contact.id), history=conversationMessages(contact.id);
            const formRule=config.get().schema.defaults.shortFormOffer;
            const incoming=history.filter(m=>m.direction==='inbound'&&m.author!=='customer_form');
            const projectInterest=Boolean(intent.projectInterest||currentProject.acquisitionIntent?.projectInterest);
            const alreadyLinked=history.some(m=>m.direction==='outbound'&&['sent','simulated_sent'].includes(m.status)&&m.text.includes('/customer#')&&/\bform\b|表单|需求表/i.test(m.text));
            const due=formRule?.enabled && incoming.length>=formRule.afterCustomerMessages && projectInterest && consultationReadiness(currentProject,config.get().schema).missing.length>=formRule.minimumMissingFields;
            if (due && !currentConversation.formOfferedAt && !currentProject.intakeSubmittedAt && !alreadyLinked && !customerLink && !inbound.formSubmission && !bookingRequested && !chosenSlot && !explicitHuman && !agentHandoff && !intent.browsingOnly) {
              formOffered=true;questionField=null;referenceQuestion=null;consultationOffered=false;
            }
            if (formOffered) {
              const prefix=reply.split(/(?<=[.!?。！？])\s+/u).filter(s=>!/[?？]/.test(s)&&!/\bform\b|表单|填表/i.test(s)).slice(0,2).join(' ');
              const invite=/[\u3400-\u9fff]/u.test(text)?config.get().templates.shortFormOfferZh:config.get().templates.shortFormOffer;
              reply=(prefix?`${prefix}\n`:'')+invite;
            }
            const invitation=/(?:would|shall|want|like|ready|interested).{0,100}(?:consultation|meeting|call)|(?:要不要|想|安排|预约).{0,35}(?:真人咨询|会面|通话)/is.test(reply);
            if (!mayInvite() && (consultationOffered || invitation)) {
              consultationOffered=false;const f=nextField(projectFor(contact.id),config.get().schema);questionField=f?.id||null;
              const keep=reply.split(/(?<=[.!?。！？])\s+/u).filter(sentence=>!/(?:would|shall|want|like|ready|interested).{0,100}(?:consultation|meeting|call)|(?:要不要|想|安排|预约).{0,35}(?:真人咨询|会面|通话)/is.test(sentence)).join(' ');
              reply=(keep||'We can keep exploring your project here.')+(f?` ${f.question}`:'');
            }
            if (customerLink) { reply = /[\u3400-\u9fff]/u.test(text) ? (formRequested ? config.get().templates.shortFormLinkIntroZh : '打开日历查看免费首次真人咨询的空位，选日期和时间后确认即可：') : (formRequested ? config.get().templates.shortFormLinkIntro : 'Open the calendar to see available dates and times for your free initial consultation, then choose and confirm a time:');if(customerLink.mode==='reschedule')reply='Choose a new time for your free initial consultation. Your current appointment stays in place until you confirm the change:';reply += `\n${customerLink.url}`;questionField=null;referenceQuestion=null;consultationOffered=false;formOffered=false; }
            const coverageProject=projectFor(contact.id);
            const pendingLocation=serviceAreaStatus(coverageProject,config.get().business);
            if(pendingLocation.requiresConfirmation && !explicitHuman && (!coverageProject.serviceCoverage?.confirmationAskedAt || coverageBlocked || questionField || referenceQuestion || formOffered || consultationOffered || customerLink)){
              const template=/[\u3400-\u9fff]/u.test(text)?config.get().templates.confirmProjectLocationZh:config.get().templates.confirmProjectLocation;
              reply=template.replace('{location}',pendingLocation.location);questionField='location';locationConfirmation=true;
              referenceQuestion=null;formOffered=false;consultationOffered=false;customerLink=null;offeredThisTurn=null;selectedMedia=[];
            }

            if(outsideArea(coverageProject)){
              const qualificationQuestion=/[?？]/.test(reply)&&/budget|size|space|layout|permit|plans|blueprints|lot|land|project.{0,30}(?:where|area)|项目|预算|面积|户型|图纸|地块/i.test(reply);
              if(!explicitHuman && (!coverageProject.serviceCoverage?.noticeSentAt || inbound.formSubmission || coverageBlocked || questionField || referenceQuestion || formOffered || consultationOffered || customerLink || qualificationQuestion)){
                reply=coverageReply(coverageProject,text);coverageNotice=true;selectedMedia=[];
              }
              questionField=null;referenceQuestion=null;formOffered=false;consultationOffered=false;customerLink=null;offeredThisTurn=null;
            }
            const firstReply = !conversationMessages(contact.id).some(m=>m.direction === 'outbound' && ['sent','simulated_sent'].includes(m.status));
            if (firstReply && !reply.includes(config.get().business.website)) reply += `\n${config.get().business.website}`;
            if (consultationOffered && !/\bfree\b|免费/i.test(reply)) reply += /[\u3400-\u9fff]/u.test(reply) ? '首次真人咨询是免费的。' : ' The initial consultation with our team is free.';
            const fresh = requireRecord('conversations', contact.id);
            if (agentHandoff) purpose = 'handoff_notice';
            const allowedOwnership = purpose === 'handoff_notice' ? expectedOwnership + 1 : expectedOwnership;
            const stale = fresh.messageVersion !== inbound.version || fresh.ownershipVersion !== allowedOwnership;
            const quickReplies = makeQuickReplies({ config: config.get(), questionField, referenceQuestion, consultationOffered, formOffered, slots: offeredThisTurn, intro: firstReply && /project or|project, or|exploring|项目需求/.test(reply), text: reply, conversation: fresh });
            const message = put('messages', { id: `reply-${inbound.id}`, contactId: contact.id, projectId: inbound.projectId || conversation.projectId, direction: 'outbound', author: 'agent', text: reply, media: selectedMedia, coverageNotice, locationConfirmation, questionField, referenceQuestion, consultationOffered, formOffered, quickReplies, replyToVersion: inbound.version, sourceMessageId: inbound.messageId, sequence: Date.now(), status: stale ? 'cancelled' : fresh.mode === 'review' ? 'draft' : 'pending', purpose, error: stale ? 'Newer message or human ownership superseded the reply' : null });
            if (!stale && fresh.mode !== 'review') {
              const sent = await sendMessage(message, purpose);
              const latestProject = projectFor(contact.id);
              if (['sent', 'simulated_sent'].includes(sent.status) && purpose === 'reply' && !serviceAreaStatus(latestProject,config.get().business).requiresConfirmation && !outsideArea(latestProject) && !latestProject.bookedAt && !list('tasks').some(task => task.contactId === contact.id && task.type === 'followup' && task.status === 'pending')) scheduleFollowup(contact.id, { dueAt: new Date(Date.now() + (settings().followupHours || 12) * 3600000).toISOString(), reason: 'One gentle follow-up after the customer conversation; eligibility checked when due.' });
            }
          }
        }
        const p = projectFor(inbound.contactId), conv = requireRecord('conversations', inbound.contactId);
        put('conversations', { ...conv, summary: `${Object.entries(p.facts).map(([key, fact]) => `${key}: ${fact.value}`).join(' · ') || 'Project details still to be discovered.'}` });
        put('inbound_events', { ...inbound, status: 'complete', error: null, processedAt: now() });
      } catch (error) {
        const latest=requireRecord('conversations',inbound.contactId);
        if(latest.messageVersion!==inbound.version || latest.projectId!==conversation.projectId){put('inbound_events',{...inbound,status:'superseded',error:null});return;}
        put('inbound_events', { ...inbound, status: 'failed', error: error.message });
        handoff(inbound.contactId, `Agent could not complete this turn: ${error.message}`, 'normal');
      }
    });
  }

  async function receive(input, background = false, { preserveReplyWindow = false, formAnswers = null } = {}) {
    const eventId = requiredText(input.eventId, 'Event ID', 200);
    const id = createHash('sha256').update(eventId).digest('hex');
    const prior = get('inbound_events', id);
    if (prior) return { duplicate: true, event: prior };
    let contact = requireRecord('contacts', input.contactId);
    const text = requiredText(input.text, 'Message text', 6000);
    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
    if (!Number.isFinite(receivedAt.getTime()) || receivedAt.getTime() > Date.now() + 60000) throw new AppError('Invalid received timestamp.');
    let conversation = requireRecord('conversations', contact.id);
    const explicitUrl = text.match(/https:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv)\/[A-Za-z0-9_-]+\/?/i)?.[0];
    const commentSource = contact.commentAcquisition?.mediaId;
    const reference = input.postId || explicitUrl || (!conversation.sourcePostId && commentSource ? commentSource : null);
    const referencedPost = reference ? content.find(reference) : null;
    if (input.postId && !referencedPost) throw new AppError('Linked source post was not found.', 404);
    // An explicit unknown link clears old context instead of answering about the wrong reel.
    let sourcePostId = referencedPost?.id || (explicitUrl ? null : conversation.sourcePostId || null);
    if (conversation.lastInboundAt && receivedAt.getTime() < Date.parse(conversation.lastInboundAt)) {
      put('messages', { id: `in-${id}`, contactId: contact.id, projectId: conversation.projectId, direction: 'inbound', author: 'customer', text, status: 'historical', sequence: Date.now(), createdAt: receivedAt.toISOString(), sourceEventId: eventId });
      return { duplicate: false, event: put('inbound_events', { id, contactId: contact.id, sourceEventId: eventId, status: 'superseded', reason: 'Historical event retained without reopening the reply window.' }) };
    }
    const developerTestReset=!preserveReplyWindow && !input.quickReplyPayload && /^hi$/i.test(text.trim()) && isDeveloperTester(contact);
    if(developerTestReset){resetDeveloperConversation(contact,eventId);contact=requireRecord('contacts',contact.id);conversation=requireRecord('conversations',contact.id);sourcePostId=null;}
    const version = conversation.messageVersion + 1;
    const messageId = `in-${id}`;
    const quickReply = resolveQuickReply({ allowMockTextSelection: (env.ACQUISITION_AI_PROVIDER || env.AI_PROVIDER || 'mock') === 'mock', payload: input.quickReplyPayload, text, messages: conversationMessages(contact.id), conversation, config: config.get() });
    const agentText = quickReply && !quickReply.invalid ? quickReply.type === 'field' ? `${config.get().schema.fields.find(f=>f.id === quickReply.fieldId).label}: ${quickReply.value}` : quickReply.type === 'intent' ? quickReply.text : quickReply.type === 'questionnaire' ? `${config.get().questionnaire.questions.find(q=>q.id === quickReply.questionId).question} Answer: ${quickReply.value}` : text : text;
    store.transaction(() => {
      put('messages', { id: messageId, contactId: contact.id, projectId: conversation.projectId, direction: 'inbound', author: preserveReplyWindow ? 'customer_form' : 'customer', text, quickReply, status: 'received', sequence: Date.now(), createdAt: receivedAt.toISOString(), sourceEventId: eventId, sourcePostId });
      put('conversations', { ...conversation, messageVersion: version, sourcePostId, lastInboundAt: preserveReplyWindow ? conversation.lastInboundAt : receivedAt.toISOString(), replyWindowUntil: preserveReplyWindow ? conversation.replyWindowUntil : new Date(receivedAt.getTime() + 24 * 3600000).toISOString() });
      put('contacts', { ...contact, firstReplyAt: preserveReplyWindow ? contact.firstReplyAt : contact.firstReplyAt || receivedAt.toISOString(), lastInteractionAt: receivedAt.toISOString() });
      let project = projectFor(contact.id);
      if (project.stage === 'prospect') setStage(project, 'engaged', 'Customer sent a direct message', messageId);
      markTasksObsolete(contact.id, 'Customer sent a new message');
      cancelDrafts(contact.id, 'Customer sent a newer message');
      put('inbound_events', { id, sourceEventId: eventId, contactId: contact.id, messageId, text: agentText, quickReply, developerTestReset, projectId: conversation.projectId, formSubmission: preserveReplyWindow, formAnswers, version, sourcePostId, status: 'queued', receivedAt: receivedAt.toISOString() });
    });
    if (background) { void runEvent(id).then(sync).catch(() => {}); }
    else { await runEvent(id); if (providers.modes.drive === 'mock') await sync(); }
    return { duplicate: false, event: requireRecord('inbound_events', id) };
  }

  async function retryFailedEvent(id) {
    const inbound = requireRecord('inbound_events', id), conv = requireRecord('conversations', inbound.contactId);
    if (inbound.status !== 'failed' || inbound.version !== conv.messageVersion) throw new AppError('Only the latest failed turn can be retried.', 409);
    if (list('messages').some(m=>m.sourceMessageId === inbound.messageId && m.direction === 'outbound') || list('tool_runs').some(r=>r.sourceMessageId === inbound.messageId && r.name === 'book_meeting')) throw new AppError('This turn has a send or booking outcome; reconcile it before retrying.', 409);
    put('inbound_events', { ...inbound, status: 'queued', error: null });
    await runEvent(id);
    const result = requireRecord('inbound_events', id);
    if (result.status === 'complete') for (const h of list('handoffs').filter(h=>h.contactId === inbound.contactId && activeTestRecord(h) && h.scope === 'topic' && h.status === 'waiting' && h.reason === `Agent could not complete this turn: ${inbound.error}`)) put('handoffs', { ...h, status: 'resolved', answer: 'Failed model turn recovered using existing facts.', resolvedAt: now() });
    return result;
  }

  function driveRecord(contactId){const job=get('sync_jobs',`customer-summary-${contactId}`);return {url:job?.fileId?`https://drive.google.com/file/d/${encodeURIComponent(job.fileId)}/view`:null,status:job?.status||'pending',lastSyncedAt:job?.lastSyncedAt||null};}
  function notifications(){return {items:list('handoffs').filter(h=>activeTestRecord(h)&&h.status==='waiting').map(h=>({id:h.id,contactId:h.contactId,name:get('contacts',h.contactId)?.name||'Customer',handle:get('contacts',h.contactId)?.handle,kind:h.requestKind||'question',reason:h.reason,priority:h.priority,createdAt:h.createdAt}))};}
  function acquisitionInsights(contacts) {
    const people = contacts || list('contacts').map(contact => ({ ...contact, driveRecord:driveRecord(contact.id), developerTest: isDeveloperTester(contact), conversation: get('conversations',contact.id), project: projectFor(contact.id), signals: signals(projectFor(contact.id),contact,conversationMessages(contact.id),config.get()) }));
    return summarizeAcquisition({contacts:people,projects:list('projects').filter(p=>!p.archivedTest),messages:list('messages').filter(activeTestRecord),comments:list('comments').filter(c=>!c.archivedTest),bookings:list('bookings').filter(activeTestRecord),archivedTestRounds:list('developer_test_runs').length});
  }

  function state() {
    const conf = config.get();
    const contacts = list('contacts').map(contact => {
      const conversation = get('conversations', contact.id), project = projectFor(contact.id);
      return { ...contact, driveRecord:driveRecord(contact.id), developerTest: isDeveloperTester(contact), conversation, project, signals: signals(project, contact, conversationMessages(contact.id), conf), eligibility: sendEligibility(contact, conversation) };
    });
    const jobs = list('sync_jobs');
    return {
      contacts, projects: list('projects').filter(p=>!p.archivedTest), messages: list('messages').filter(activeTestRecord), interactions: list('interactions'), outreach: list('outreach'), contentMetrics: list('content_metrics'), handoffs: list('handoffs').filter(activeTestRecord), tasks: list('tasks').filter(activeTestRecord), bookings: list('bookings').filter(activeTestRecord), assets: list('assets'), posts: list('posts'), activity: list('activity').slice(0, 50), toolRuns: list('tool_runs').filter(activeTestRecord).slice(0, 100), quotes: list('quotes').filter(activeTestRecord),
      config: { schema: conf.schema, business: conf.business, questionnaire: conf.questionnaire, loadedAt: conf.loadedAt }, settings: settings(), stages: STAGES, modes: MODES,
      integrations: { ...providers.status, whatsapp:teamNotifications.status(), ai: { mode: agent.mode, label: agent.mode === 'mock' ? 'Offline demo agent · deterministic extraction' : 'Claude tool-calling agent' }, video: { mode: env.VIDEO_VISION_PROVIDER || (agent.mode === 'claude' ? 'claude' : 'metadata'), label: (env.VIDEO_VISION_PROVIDER || (agent.mode === 'claude' ? 'claude' : 'metadata')) === 'claude' ? 'Claude vision · original video fallback + metadata' : 'Video metadata & provenance · no pixel inspection' } },
      sync: { pending: jobs.filter(job => job.status === 'pending').length, failed: jobs.filter(job => job.status === 'failed').length, local: jobs.filter(job => job.status === 'local_mirror').length, synced: jobs.filter(job => job.status === 'synced').length, failures: jobs.filter(job => job.status === 'failed').slice(0, 5).map(job => ({ path: job.path, error: job.error })) },
      insights: acquisitionInsights(contacts),
      customerRecordsSource: get('sync_jobs','table-CustomerRecords')?.fileId ? `https://drive.google.com/file/d/${encodeURIComponent(get('sync_jobs','table-CustomerRecords').fileId)}/view` : null,
      funnel: summarizeFunnel(list('contacts'), list('projects'), list('outreach'), settings()),
      comments: list('comments').filter(c=>!c.archivedTest), commentFunnel: comments.funnel(),
      demo: providers.modes.instagram === 'mock'
    };
  }

  function updateSettings(input) {
    const current = settings(); const allowed = ['quoteMode', 'replyMode', 'outreachMode', 'observationDays'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new AppError('Unsupported setting.');
    if (input.quoteMode && !['off', 'review_required', 'auto'].includes(input.quoteMode)) throw new AppError('Invalid quote mode.');
    if (input.replyMode && !['auto', 'review'].includes(input.replyMode)) throw new AppError('Invalid reply mode.');
    if (input.outreachMode && !['review', 'auto'].includes(input.outreachMode)) throw new AppError('Invalid outreach mode.');
    if (input.observationDays !== undefined && ![7, 30].includes(Number(input.observationDays))) throw new AppError('Choose a 7- or 30-day cohort window.');
    if (input.quoteMode === 'auto' && JSON.parse(readFileSync(path.join(config.directory, 'pricing.json'), 'utf8')).mode !== 'approved') throw new AppError('Automatic quotes require an owner-approved rate card. Demo rates cannot be enabled.', 409);
    const result = put('settings', { ...current, ...input, id: 'workspace', observationDays: Number(input.observationDays || current.observationDays) });
    if (input.quoteMode === 'off') for (const quote of list('quotes').filter(quote => quote.status === 'review_required')) put('quotes', { ...quote, status: 'cancelled' });
    event('settings_updated', 'Workspace automation settings updated', 'workspace');
    return result;
  }

  async function mode(contactId, input) {
    if (!MODES.includes(input.mode)) throw new AppError('Invalid conversation mode.');
    const conversation = requireRecord('conversations', contactId);
    if (requireRecord('contacts', contactId).doNotContact && input.mode !== 'paused') throw new AppError('This customer opted out. Contact preferences must be reviewed separately.', 409);
    const result = put('conversations', { ...conversation, mode: input.mode, ownershipVersion: conversation.ownershipVersion + 1, owner: optionalText(input.owner, 100) || conversation.owner || 'Sales team' });
    cancelDrafts(contactId, `Conversation mode changed to ${input.mode}`);
    if (['human', 'paused', 'awaiting_human'].includes(input.mode)) markTasksObsolete(contactId, 'Conversation handed to a person or paused');
    for (const item of list('handoffs').filter(item => item.contactId === contactId && ((item.scope || 'conversation') === 'conversation' || item.requestKind === 'live_chat') && ['waiting', 'claimed'].includes(item.status))) put('handoffs', { ...item, status: input.mode === 'human' ? 'claimed' : ['auto', 'review'].includes(input.mode) ? 'released' : item.status, owner: result.owner });
    event('ownership_changed', `Conversation is now ${input.mode}`, contactId);
    return result;
  }
  async function humanReply(contactId, input) {
    const conversation = requireRecord('conversations', contactId);
    if (requireRecord('contacts', contactId).doNotContact) throw new AppError('Customer opted out.', 409);
    const text = requiredText(input.text, 'Reply', 4000);
    cancelDrafts(contactId, 'A team member is replying'); markTasksObsolete(contactId, 'A team member is replying');
    conversation.messageVersion += 1;
    put('conversations', conversation);
    const message = put('messages', { contactId, projectId: conversation.projectId, direction: 'outbound', author: 'human', text, status: 'pending', sequence: Date.now(), replyToVersion: conversation.messageVersion });
    const sent=await sendMessage(message, 'reply', true);
    if(['sent','simulated_sent'].includes(sent.status))for(const h of list('handoffs').filter(h=>h.contactId===contactId&&h.projectId===conversation.projectId&&h.requestKind==='live_chat'&&['waiting','claimed'].includes(h.status)))put('handoffs',{...h,status:'resolved',answerMessageId:sent.id,answer:'Team joined the Instagram conversation.',resolvedAt:now()});
    return sent;
  }
  async function resolveHandoff(id, input) {
    const item = requireRecord('handoffs', id);
    if (item.scope !== 'topic' || !['waiting', 'claimed'].includes(item.status)) throw new AppError('Only an open question can be resolved.', 409);
    if (item.answerMessageId && ['sending','send_unknown','pending'].includes(get('messages', item.answerMessageId)?.status)) throw new AppError('Previous reply needs delivery verification before resending.',409);
    const answer = requiredText(input.answer, 'Verified team answer', 4000);
    let message = null;
    if (input.sendToCustomer === true) message = await humanReply(item.contactId, { text: answer });
    const success = !message || ['sent', 'simulated_sent'].includes(message.status);
    return put('handoffs', { ...item, answer, answerMessageId: message?.id || null, status: success ? 'resolved' : item.status, resolution: message?.status || 'internal_answer', resolvedAt: success ? now() : null });
  }
  async function approveReply(messageId) {
    const message = requireRecord('messages', messageId);
    if (message.status !== 'draft') throw new AppError('Only a pending draft can be approved.', 409);
    return sendMessage(message, message.purpose || 'reply');
  }
  function saveFacts(contactId, input) {
    const project = projectFor(contactId);
    return reconcileCoverage(put('projects', applyFacts(project, input.updates, config.get().schema, input.sourceMessageId || null, input.author === 'customer' ? 'customer_form' : 'human')));
  }
  function updateProject(contactId, input) {
    let project = projectFor(contactId);
    if (input.owner !== undefined) project = put('projects', { ...project, owner: requiredText(input.owner, 'Owner', 100) });
    if (input.stage === 'lost' && !input.reason?.trim()) throw new AppError('Provide the customer’s explicit reason for abandoning the project.');
    if (input.stage !== undefined) project = setStage(project, input.stage, optionalText(input.reason, 1000) || 'Updated by the team', null, 'human');
    if (['lost', 'paused'].includes(input.stage)) {
      const conv = requireRecord('conversations', contactId);
      put('conversations', { ...conv, mode: 'paused', ownershipVersion: conv.ownershipVersion + 1 });
      cancelDrafts(contactId, `Project marked ${input.stage}`); markTasksObsolete(contactId, `Project marked ${input.stage}`);
    }
    return project;
  }
  function addInteraction(input) {
    if (!['like', 'comment', 'story_reply', 'share_visible'].includes(input.type)) throw new AppError('Only identifiable interactions can create prospect records. Views belong in content metrics.');
    const contact = requireRecord('contacts', input.contactId);
    const sourceId = requiredText(input.sourceId, 'Source event ID', 200);
    const prior = list('interactions').find(item => item.sourceId === sourceId);
    if (prior) return prior;
    const value = put('interactions', { contactId: contact.id, sourceId, type: input.type, postId: requiredText(input.postId, 'Post ID', 200), source: input.source === 'api' ? 'api' : 'browser_observed', observedAt: now(), evidence: optionalText(input.evidence, 1000), identityVerified: input.identityVerified === true });
    put('contacts', { ...contact, lastInteractionAt: now() }); return value;
  }
  function addMetrics(input) {
    const metrics = {};
    for (const name of ['views', 'reach', 'likes', 'shares', 'watchTimeSeconds', 'completionRate']) {
      const value = input[name];
      if (value === undefined || value === null || value === '') metrics[name] = null;
      else { const n = Number(value); if (!Number.isFinite(n) || n < 0 || (name === 'completionRate' && n > 1)) throw new AppError(`Invalid metric ${name}.`); metrics[name] = n; }
    }
    return put('content_metrics', { postId: requiredText(input.postId, 'Post ID', 200), ...metrics, observedAt: now(), source: 'manual_snapshot', note: 'Aggregate metrics. No viewer identities are inferred.' });
  }
  function queueOutreach(contactId) {
    const contact = requireRecord('contacts', contactId), conversation = requireRecord('conversations', contactId);
    const existing = list('outreach').find(job => job.contactId === contactId && !['cancelled', 'failed'].includes(job.status));
    if (existing) return existing;
    const check = sendEligibility(contact, conversation, Date.now(), 'outreach');
    if (!check.allowed) throw new AppError(check.reason, 409);
    const value = put('outreach', { contactId, text: config.get().templates.intro, templateVersion: 'intro-v1', source: contact.source, executor: 'browser', status: settings().outreachMode === 'auto' ? 'approved' : 'draft', delivery: 'unknown' });
    event('outreach_drafted', `First-touch draft for @${contact.handle}`, contactId);
    return value;
  }
  async function executeOutreach(id) {
    return locked(`outreach-${id}`, async () => {
      const job = requireRecord('outreach', id);
      if (!['draft', 'approved'].includes(job.status)) throw new AppError('This outreach is completed, pending execution or needs reconciliation; do not resend.', 409);
      const contact = requireRecord('contacts', job.contactId), conversation = requireRecord('conversations', job.contactId);
      const check = sendEligibility(contact, conversation, Date.now(), 'outreach');
      if (!check.allowed) throw new AppError(check.reason, 409);
      put('outreach', { ...job, status: 'sending', approvedAt: now() });
      try {
        const result = await providers.browser.send(job, contact, () => { const c = requireRecord('contacts', job.contactId), conv = requireRecord('conversations', job.contactId); return sendEligibility(c, conv, Date.now(), 'outreach').allowed && conv.ownershipVersion === conversation.ownershipVersion && conv.messageVersion === conversation.messageVersion; });
        const value = put('outreach', { ...job, ...result, sentAt: ['sent', 'simulated_sent'].includes(result.status) ? now() : null, approvedAt: now() });
        if (result.status === 'send_unknown') put('contacts', { ...requireRecord('contacts', contact.id), outreachStatus: 'send_unknown' });
        if (['sent', 'simulated_sent'].includes(result.status)) {
          put('contacts', { ...requireRecord('contacts', contact.id), outreachStatus: result.status });
          put('messages', { contactId: contact.id, projectId: conversation.projectId, direction: 'outbound', author: 'outreach', text: job.text, sequence: Date.now(), status: result.status, externalId: result.externalId, sentAt: value.sentAt });
        }
        event('outreach_executed', `@${contact.handle}: ${result.status}`, contact.id);
        return value;
      } catch (error) { put('contacts', { ...requireRecord('contacts', contact.id), outreachStatus: 'send_unknown' }); return put('outreach', { ...job, status: 'send_unknown', error: error.message }); }
    });
  }
  function reconcileOutreach(id, input) {
    const job = requireRecord('outreach', id);
    if (!['send_unknown', 'needs_manual_execution'].includes(job.status)) throw new AppError('This outreach does not need reconciliation.', 409);
    if (!['sent', 'not_sent'].includes(input.result)) throw new AppError('Confirm sent or not_sent.');
    const evidence = requiredText(input.evidence, 'Verification evidence', 1000);
    const contact = requireRecord('contacts', job.contactId), conversation = requireRecord('conversations', job.contactId);
    const value = put('outreach', { ...job, status: input.result === 'sent' ? 'sent' : 'failed', evidence, sentAt: input.result === 'sent' ? now() : null, reconciledAt: now() });
    put('contacts', { ...contact, outreachStatus: input.result === 'sent' ? 'sent' : 'not_contacted' });
    if (input.result === 'sent') put('messages', { contactId: contact.id, projectId: conversation.projectId, direction: 'outbound', author: 'outreach', text: job.text, sequence: Date.now(), status: 'sent', sentAt: value.sentAt, evidence });
    return value;
  }
  function scheduleFollowup(contactId, input) {
    if(outsideArea(projectFor(contactId)) || serviceAreaStatus(projectFor(contactId),config.get().business).requiresConfirmation)throw new AppError('Project is outside the service area; automatic follow-ups are paused.',409);
    const dueAt = new Date(input.dueAt);
    if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= Date.now()) throw new AppError('Choose a future follow-up time.');
    const conversation = requireRecord('conversations', contactId);
    const existing = list('tasks').find(task => task.contactId === contactId && task.type === 'followup' && task.status === 'pending');
    return put('tasks', { ...(existing || {}), contactId, type: 'followup', title: 'Project follow-up', dueAt: dueAt.toISOString(), reason: requiredText(input.reason, 'Reason', 500), status: 'pending', inboundVersion: conversation.messageVersion });
  }
  async function runTasks() {
    return locked('task-worker', async () => {
    let processed = 0;
    for (const task of list('tasks').filter(task => task.type === 'followup' && task.status === 'pending' && Date.parse(task.dueAt) <= Date.now())) {
      if(outsideArea(projectFor(task.contactId)) || serviceAreaStatus(projectFor(task.contactId),config.get().business).requiresConfirmation){put('tasks',{...task,status:'cancelled',resolution:'Project is outside the service area'});continue;}
      const contact = requireRecord('contacts', task.contactId), conversation = requireRecord('conversations', task.contactId);
      const check = sendEligibility(contact, conversation);
      if (!check.allowed || conversation.messageVersion !== task.inboundVersion || projectFor(contact.id).bookedAt) put('tasks', { ...task, status: 'human_action', resolution: check.reason || 'Conversation progressed; review before following up.' });
      else {
        const message = put('messages', { id: `task-${task.id}`, contactId: contact.id, projectId: conversation.projectId, direction: 'outbound', author: 'agent', text: config.get().templates.followup, sequence: Date.now(), replyToVersion: conversation.messageVersion, status: conversation.mode === 'review' ? 'draft' : 'pending' });
        const sent = conversation.mode === 'review' ? message : await sendMessage(message);
        put('tasks', { ...task, status: sent.status === 'draft' ? 'awaiting_review' : ['sent', 'simulated_sent'].includes(sent.status) ? 'complete' : 'human_action', resolution: sent.status });
      }
      processed++;
    }
    return { processed };
    });
  }
  async function cancelBooking(id) {
    const original=requireRecord('bookings',id);
    return locked(original.contactId,async()=>{
      const run=calendarLock.catch(()=>{}).then(async()=>{
        const booking=requireRecord('bookings',id);
        if(!['simulated','confirmed'].includes(booking.status)||['pending','unknown'].includes(booking.rescheduleAttempt?.status))throw new AppError('Verify any pending appointment change before cancelling.',409);
        await providers.calendar.cancel(booking);
        const result=put('bookings',{...booking,status:'cancelled',revision:(booking.revision||0)+1});
        const project=requireRecord('projects',booking.projectId);
        setStage(put('projects',{...project,bookedAt:null}),'engaged','Consultation cancelled; needs rescheduling',null,'human');
        for(const task of list('tasks').filter(t=>t.contactId===booking.contactId&&t.type==='human'&&['pending','due'].includes(t.status)&&(t.bookingId===id||(!t.bookingId&&t.dueAt===booking.start))))put('tasks',{...task,status:'cancelled',resolution:'Appointment cancelled'});
        return result;
      });calendarLock=run;return run;
    });
  }
  async function reconcileBooking(id) {
    const booking = requireRecord('bookings', id);
    if(['pending','unknown'].includes(booking.rescheduleAttempt?.status)){
      const verified=await customerPages.reconcileReschedule(id);
      if(verified.status==='cancelled'){const p=requireRecord('projects',verified.projectId);setStage(put('projects',{...p,bookedAt:null}),'engaged','Calendar cancellation verified',null,'human');for(const task of list('tasks').filter(t=>t.bookingId===id&&t.type==='human'&&['pending','due'].includes(t.status)))put('tasks',{...task,status:'cancelled',resolution:'Calendar cancellation verified'});}
      for(const task of list('tasks').filter(t=>t.bookingId===id&&t.type==='booking_verification'&&t.status==='pending'))put('tasks',{...task,status:'complete',resolution:'Calendar change verified: '+verified.rescheduleAttempt.status});
      return verified;
    }
    if (!['pending', 'unknown'].includes(booking.status)) throw new AppError('This booking does not need reconciliation.', 409);
    const result = await providers.calendar.reconcile(booking.requestKey);
    if (!result) throw new AppError('No confirmed result found. Keep this booking unresolved.', 409);
    const updated = put('bookings', { ...booking, ...result });
    if (result.status === 'confirmed') { const project = requireRecord('projects', booking.projectId); setStage(put('projects', { ...project, bookedAt: now() }), 'meeting_booked', 'Calendar event verified', null, 'human'); }
    return updated;
  }
  function addAsset(input) {
    const title = requiredText(input.title, 'Asset title', 200);
    const url = requiredText(input.url, 'Asset URL', 1000);
    if (!url.startsWith('/uploads/') && !url.startsWith('/assets/')) throw new AppError('Use a locally uploaded asset or approved built-in illustration.');
    return put('assets', { title, url, tags: optionalText(input.tags, 500).split(',').map(tag => tag.trim()).filter(Boolean), approved: input.approved === true, demo: url.startsWith('/assets/'), description: optionalText(input.description, 1000), driveFileId: input.driveFileId || null });
  }
  function approveAsset(id, approved) {
    if (typeof approved !== 'boolean') throw new AppError('Approval must be true or false.');
    return put('assets', { ...requireRecord('assets', id), approved });
  }
  function linkPost(contactId, reference) {
    const post = content.find(reference);
    if (!post) throw new AppError('Source post not found.', 404);
    const conv = requireRecord('conversations', contactId);
    cancelDrafts(contactId, 'Source post context changed');
    return put('conversations', { ...conv, sourcePostId: post.id, messageVersion: conv.messageVersion + 1 });
  }
  async function importLibrary() {
    const files = await providers.drive.listSourceFiles();
    let imported = 0;
    for (const file of files) {
      const prior = list('assets').find(asset => asset.driveFileId === file.id);
      if (prior) continue;
      const id = randomUUID();
      put('assets', { id, title: file.name, description: file.description || '', tags: [], approved: false, demo: false, url: `/api/assets/${id}/file`, driveFileId: file.id, mimeType: file.mimeType, size: Number(file.size) });
      imported++;
    }
    return { imported, scanned: files.length, approvalRequired: true };
  }
  function newProject(contactId, input) {
    requireRecord('contacts', contactId);
    const project = put('projects', { contactId, title: requiredText(input.title, 'Project title', 100), facts: {}, factHistory: [], asked: {}, attachments: [], stage: 'engaged', owner: 'Intake team', stageHistory: [], bookingIntent: false });
    const conversation = requireRecord('conversations', contactId);
    put('conversations', { ...conversation, projectId: project.id, offeredSlots: [], lastAskedField: null, messageVersion: conversation.messageVersion + 1 });
    cancelDrafts(contactId, 'A new project is active');
    return project;
  }
  function queueConfigSnapshots() {
    for (const file of ['qualification.schema.json', 'business-profile.json', 'message-templates.json', 'acquisition-settings.json', 'demo-extraction.json', 'quick-replies.json', 'reference-questionnaire.json']) {
      const value = JSON.parse(readFileSync(path.join(config.directory, file), 'utf8'));
      store.put('acq_sync_jobs', { id: `config-${file}`, kind: 'config', path: `config/${file}`, payload: value, revision: randomUUID(), status: 'pending', attempts: 0 });
    }
  }
  function currentCustomerRecord(c){const p=projectFor(c.id);return customerRecord({contact:c,project:p,conversation:get('conversations',c.id),config:config.get(),messages:conversationMessages(c.id),bookings:list('bookings').filter(b=>b.projectId===p.id),handoffs:list('handoffs').filter(h=>h.projectId===p.id),comments:list('comments').filter(x=>x.contactId===c.id&&!x.archivedTest)});}
  function queueTables() {
    for(const c of list('contacts')){
      const id=`customer-summary-${c.id}`,previous=get('sync_jobs',id),payload=customerRecordText(currentCustomerRecord(c));
      if(previous?.payload!==payload)store.put('acq_sync_jobs',{...previous,id,kind:'customer_summary',path:`collected-data/contacts/${c.id}/customer-record.txt`,mimeType:'text/plain',payload,revision:randomUUID(),status:'pending',attempts:0});
    }
    const conf = config.get();
    const tables = {
      Prospects: list('contacts').map(c => { const p = projectFor(c.id), conv = requireRecord('conversations', c.id), s = signals(p, c, conversationMessages(c.id), conf); return { contactId: c.id, handle: c.handle, name: c.name, source: c.source, doNotContact: c.doNotContact, firstReplyAt: c.firstReplyAt, stage: p.stage, intent: s.intent, activity: s.activity, fit: s.fit, mode: conv.mode, lossReason: p.lossReason?.reason || null, ...Object.fromEntries(conf.schema.fields.map(f => [f.id, p.facts[f.id]?.value ?? null])) }; }),
      Interactions: list('interactions'), Outreach: list('outreach'), ContentMetrics: list('content_metrics'), Comments: list('comments'), CommentFunnel: comments.funnel(),
      AcquisitionInsights: acquisitionInsights(),
      CustomerRecords: list('contacts').map(c=>currentCustomerRecord(c)),
      Funnel: summarizeFunnel(list('contacts'), list('projects'), list('outreach'), settings())
    };
    for (const [name, payload] of Object.entries(tables)) {
      const id = `table-${name}`, previous = get('sync_jobs', id);
      if (JSON.stringify(previous?.payload) !== JSON.stringify(payload)) store.put('acq_sync_jobs', { id, kind: 'table', path: `tables/${name}.json`, payload, revision: randomUUID(), status: 'pending', attempts: 0 });
    }
  }
  function recoverInterrupted() {
    teamNotifications.recover();
    comments.recover();
    for(const c of list('contacts'))reconcileCoverage(projectFor(c.id));
    for (const message of list('messages').filter(m => ['sending', 'pending'].includes(m.status))) put('messages', { ...message, status: 'send_unknown', error: 'Process restarted during send; verify before any retry.' });
    for (const job of list('outreach').filter(j => j.status === 'sending')) {
      put('outreach', { ...job, status: 'send_unknown', error: 'Process restarted during browser execution.' });
      const c = requireRecord('contacts', job.contactId); put('contacts', { ...c, outreachStatus: 'send_unknown' });
    }
    for(const b of list('bookings').filter(b=>b.rescheduleAttempt?.status==='pending'))put('bookings',{...b,rescheduleAttempt:{...b.rescheduleAttempt,status:'unknown',error:'Restart during calendar update; verify before another change.'}});
    for (const b of list('bookings').filter(b => b.status === 'pending')) put('bookings', { ...b, status: 'unknown', error: 'Process restarted during booking; reconcile the deterministic event ID.' });
    for (const e of list('inbound_events').filter(e => e.status === 'processing')) {
      put('inbound_events', { ...e, status: 'failed', error: 'Process interrupted during agent turn.' });
      handoff(e.contactId, 'Interrupted agent turn needs review before continuing.');
    }
  }
  let workerPromise;
  async function tick() {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      await reconcileEchoes();
      for (const e of list('inbound_events').filter(e => e.status === 'queued')) await runEvent(e.id);
      for (const c of list('comments').filter(c => c.status === 'queued')) await comments.run(c.id);
      await runTasks();
      await teamNotifications.run();
      await sync();
    })();
    try { await workerPromise; } finally { workerPromise = null; }
  }
  if (!get('settings', 'workspace')) put('settings', { id: 'workspace', ...config.get().defaults });
  if (seed && !get('meta', 'seed-v2')) {
    const alex = createContact({ handle: 'alex.demo', name: 'Alex Morgan', source: 'Instagram DM', instagramId: 'demo-alex' });
    const mia = createContact({ handle: 'mia.demo', name: 'Mia Chen', source: 'Liked · Cedar House', instagramId: 'demo-mia' });
    const sam = createContact({ handle: 'sam.demo', name: 'Sam Rivera', source: 'Comment · Modern homes', instagramId: 'demo-sam' });
    const message = put('messages', { contactId: alex.id, projectId: projectFor(alex.id).id, direction: 'inbound', author: 'customer', text: 'Hi! We’re planning a home in Bellevue, around 2,400 sqft, with 4 bedrooms and 3 bathrooms. Permit not started yet.', status: 'received', sequence: Date.now() });
    let p = saveFacts(alex.id, { updates: [{ fieldId: 'location', value: 'Bellevue', status: 'confirmed' }, { fieldId: 'square_footage', value: '2,400 sqft', status: 'confirmed' }, { fieldId: 'layout', value: '4 bedrooms and 3 bathrooms', status: 'confirmed' }, { fieldId: 'permit', value: 'not_started', status: 'confirmed' }], sourceMessageId: message.id, author: 'customer' });
    setStage(p, 'qualified', 'Demo customer shared a concrete project', message.id);
    const conv = get('conversations', alex.id);
    put('conversations', { ...conv, messageVersion: 1, lastInboundAt: now(), replyWindowUntil: new Date(Date.now() + 24 * 3600000).toISOString(), summary: 'Bellevue · 2,400 sqft · 4 bed / 3 bath · permit not started' });
    put('contacts', { ...alex, firstReplyAt: now() });
    addInteraction({ contactId: mia.id, sourceId: 'seed-like', type: 'like', postId: 'cedar-house', evidence: 'Synthetic visible like for the demo', identityVerified: true });
    addInteraction({ contactId: sam.id, sourceId: 'seed-comment', type: 'comment', postId: 'modern-homes', evidence: 'Synthetic comment: Do you build in Seattle?', identityVerified: true });
    addMetrics({ postId: 'cedar-house', views: 1240, reach: 860, likes: 72, shares: 11, watchTimeSeconds: 18400 });
    addAsset({ title: 'Cedar House · modern exterior', url: '/assets/house.svg', tags: 'modern, custom home, exterior', approved: true, description: 'Sample illustration only. Not a built Triple Z project.' });
    addAsset({ title: 'Cedar House · design inspiration', url: '/assets/house.svg', tags: 'inspiration, layout, home', approved: true, description: 'Second sample reference for testing media selection.' });
    put('meta', { id: 'seed-v2' });
  }
  queueConfigSnapshots();
  if (seed && !list('posts').length && existsSync(path.join(config.directory, 'video-metadata.example.json'))) content.upsert(JSON.parse(readFileSync(path.join(config.directory, 'video-metadata.example.json'), 'utf8')));
  return { teamNotifications, notifications, state, list, get, put, requireRecord, createContact, receive, receiveEcho, reconcileEchoes, runEvent, retryFailedEvent, sync, settings, updateSettings, mode, humanReply, resolveHandoff, approveReply, saveFacts, updateProject, addInteraction, addMetrics, queueOutreach, executeOutreach, reconcileOutreach, scheduleFollowup, runTasks, cancelBooking, reconcileBooking, addAsset, approveAsset, importLibrary, newProject, handoff, queueConfigSnapshots, recoverInterrupted, tick, content, comments, customerPages, linkPost, providers, config };
}
