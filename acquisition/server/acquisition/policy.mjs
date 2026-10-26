import { AppError } from '../domain.mjs';

export const STAGES = ['prospect', 'engaged', 'qualifying', 'qualified', 'meeting_booked', 'human_followup', 'won', 'lost', 'paused'];
export const MODES = ['auto', 'review', 'awaiting_human', 'human', 'paused'];
export const FACT_STATUSES = ['confirmed', 'inferred', 'unknown', 'declined'];

export function serviceAreaStatus(project, business) {
  const location=project.facts?.location;
  if(!location || location.status!=='confirmed')return {status:'unknown',location:location?.value||null,requiresConfirmation:location?.status==='inferred'};
  const normalize=value=>String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const value=` ${normalize(location.value)} `;
  const match=business.serviceAreas.find(city=>[city,...(business.serviceAreaAliases?.[city]||[])].some(name=>value.includes(` ${normalize(name)} `)));
  return {status:match?'match':'outside_service_area',location:location.value,matchedArea:match||null};
}

export function fieldApplies(field, project) {
  const answers=project.questionnaireAnswers || {};
  const required=field.whenQuestionnaire, skipped=field.skipWhenQuestionnaire;
  if(required && !required.values.includes(answers[required.questionId]?.value))return false;
  if(skipped && skipped.values.includes(answers[skipped.questionId]?.value))return false;
  return true;
}

export function consultationReadiness(project, schema) {
  const rule = schema.defaults.consultationReadiness || { fields: schema.fields.filter(f=>f.askWhen === 'project_discussion').map(f=>f.id), minimumConfirmedFields: 3 };
  const relevant=rule.fields.filter(id=>fieldApplies(schema.fields.find(f=>f.id===id),project));
  const missing = relevant.filter(id=>{const field=schema.fields.find(f=>f.id===id);return !['confirmed','unknown','declined'].includes(project.facts[id]?.status) && !project.questionnaireAnswers?.[field.answeredByQuestionnaire];});
  const confirmed = relevant.filter(id=>project.facts[id]?.status === 'confirmed').length;
  return { allowed: missing.length === 0 && confirmed >= rule.minimumConfirmedFields, missing, confirmed, minimumConfirmedFields: rule.minimumConfirmedFields };
}

export function sendEligibility(contact, conversation, now = Date.now(), purpose = 'reply') {
  if (contact.doNotContact) return { allowed: false, reason: 'Customer requested no further contact.' };
  if (['human', 'paused'].includes(conversation.mode) || (conversation.mode === 'awaiting_human' && purpose !== 'handoff_notice')) return { allowed: false, reason: 'Automation is paused for human ownership.' };
  if (purpose === 'outreach') {
    if (contact.outreachStatus && contact.outreachStatus !== 'not_contacted') return { allowed: false, reason: 'Outreach already exists; do not send another first message.' };
    if (conversation.lastInboundAt) return { allowed: false, reason: 'Customer has already started a conversation.' };
    return { allowed: true, reason: 'Eligible for the configured outreach adapter; not a platform authorization.' };
  }
  if (!conversation.replyWindowUntil || Date.parse(conversation.replyWindowUntil) <= now) return { allowed: false, reason: 'API reply window is closed; create a human task instead.' };
  return { allowed: true };
}

export function nextField(project, schema, bookingRequested = false) {
  return [...schema.fields].filter(field => {
    if (field.askWhen === 'booking_requested' && !bookingRequested) return false;
    if (!fieldApplies(field,project) || project.questionnaireAnswers?.[field.answeredByQuestionnaire]) return false;
    const fact = project.facts[field.id];
    return (!fact || fact.status === 'inferred') && !project.asked?.[field.id];
  }).sort((a, b) => b.priority - a.priority)[0] || null;
}

export function applyFacts(project, patches, schema, sourceMessageId, author = 'agent') {
  if (!Array.isArray(patches) || patches.length > 50) throw new AppError('Facts must be an array of at most 50 updates.');
  const facts = { ...project.facts };
  const history = [...(project.factHistory || [])];
  for (const patch of patches) {
    const field = schema.fields.find(field => field.id === patch.fieldId);
    if (!field || !FACT_STATUSES.includes(patch.status) || typeof patch.value !== 'string' || patch.value.length > 2000) throw new AppError('Invalid checklist update.');
    if (field.type === 'enum' && patch.status === 'confirmed' && !field.options.includes(patch.value)) throw new AppError(`Choose a configured option for ${field.label}.`);
    const previous = facts[field.id];
    if (author === 'agent' && previous?.author === 'human' && patch.status === 'inferred') continue;
    if (previous?.value === patch.value && previous?.status === patch.status) continue;
    if (previous) history.push({ fieldId: field.id, ...previous });
    facts[field.id] = { value: patch.value, status: patch.status, sourceMessageId, author, updatedAt: new Date().toISOString(), schemaVersion: schema.version };
  }
  return { ...project, facts, factHistory: history };
}

export function signals(project, contact, messages, config) {
  const customerMessages = messages.filter(message => message.direction === 'inbound');
  const latestAt = customerMessages.at(-1)?.createdAt;
  const activityAt = [latestAt, contact.lastInteractionAt].filter(Boolean).sort().at(-1);
  const age = activityAt ? Date.now() - Date.parse(activityAt) : Infinity;
  const confirmed = Object.entries(project.facts).filter(([, fact]) => fact.status === 'confirmed');
  const location = project.facts.location;
  const fit = serviceAreaStatus(project,config.business).status;
  const reasons = [];
  if(fit==='outside_service_area')reasons.push({kind:'coverage',text:'Project location is outside the configured service area; discovery and automatic invitations are paused.',messageId:location?.sourceMessageId});
  if (project.bookingIntent) reasons.push({ text: 'Customer asked about a meeting', messageId: project.bookingIntentSource });
  if (project.facts.blueprints?.value === 'available') reasons.push({ text: 'Customer has project plans', messageId: project.facts.blueprints.sourceMessageId });
  if (confirmed.length >= 3) reasons.push({ text: 'Shared at least three project details', messageId: confirmed.at(-1)[1].sourceMessageId });
  const commentHigh = contact.commentIntent?.level === 'high' && Date.now() - Date.parse(contact.commentIntent.at) < 30 * 86400000;
  if (commentHigh) reasons.push({ text: contact.commentIntent.reason, commentId: contact.commentIntent.commentId });
  const intent = project.bookingIntent || commentHigh ? 'high' : reasons.some(reason=>reason.kind!=='coverage') ? 'medium' : customerMessages.length ? 'exploring' : 'unknown';
  return { activity: age < 24 * 3600000 ? 'active' : age < 7 * 86400000 ? 'recent' : 'quiet', intent, fit, reasons, lastCustomerMessageAt: latestAt || null, knownFields: confirmed.length, totalFields: config.schema.fields.length };
}

export function summarizeFunnel(contacts, projects, outreach, settings, now = Date.now()) {
  const days = settings.observationDays || 7;
  const sent = outreach.filter(item => ['sent', 'simulated_sent'].includes(item.status));
  const byContact = new Map();
  for (const item of sent.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt))) if (!byContact.has(item.contactId)) byContact.set(item.contactId, item);
  const all = [...byContact.values()];
  const mature = all.filter(item => now - Date.parse(item.sentAt) >= days * 86400000);
  function count(rows) {
    const ids = new Set(rows.map(item => item.contactId));
    const inWindow = (contactId, timestamp) => { const first = byContact.get(contactId); return first && timestamp && Date.parse(timestamp) >= Date.parse(first.sentAt) && Date.parse(timestamp) <= Date.parse(first.sentAt) + days * 86400000; };
    const replied = contacts.filter(contact => ids.has(contact.id) && inWindow(contact.id, contact.firstReplyAt)).length;
    const qualifiedIds = new Set(projects.filter(project => ids.has(project.contactId) && inWindow(project.contactId, project.qualifiedAt)).map(project => project.contactId));
    const qualified = qualifiedIds.size;
    const bookedIds = new Set(projects.filter(project => ids.has(project.contactId) && inWindow(project.contactId, project.bookedAt)).map(project => project.contactId));
    const booked = bookedIds.size;
    const qualifiedReplied = contacts.filter(contact => qualifiedIds.has(contact.id) && inWindow(contact.id, contact.firstReplyAt)).length;
    const qualifiedBooked = [...bookedIds].filter(id => qualifiedIds.has(id)).length;
    return { sent: rows.length, replied, qualified, booked, replyRate: rows.length ? replied / rows.length : null, qualificationRate: replied ? qualifiedReplied / replied : null, bookingRate: qualified ? qualifiedBooked / qualified : null, outreachBookingRate: rows.length ? booked / rows.length : null };
  }
  return { observationDays: days, total: count(all), mature: count(mature), observing: all.length - mature.length, simulated: sent.some(item => item.status === 'simulated_sent'), unknownSends: outreach.filter(item => item.status === 'send_unknown').length, cohorts: [...new Set(all.map(item => item.templateVersion))].map(version => ({ templateVersion: version, ...count(all.filter(item => item.templateVersion === version)) })), note: 'Unique contacts; first outbound cohort; conversions inside the observation window. Anonymous viewing metrics are not person-level leads.' };
}
