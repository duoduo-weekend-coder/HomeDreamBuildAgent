import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../domain.mjs';
import { validateReplyOptions } from './quick-replies.mjs';
import { validateSafetyPolicy } from './safety.mjs';

export function validateSchema(schema) {
  if (!schema || !Number.isInteger(schema.version) || schema.version < 1 || !Array.isArray(schema.fields) || !schema.fields.length || schema.fields.length > 50) throw new AppError('Checklist requires a positive version and 1–50 fields.');
  const ids = new Set();
  for (const field of schema.fields) {
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(field.id) || ['constructor', 'prototype', '__proto__'].includes(field.id) || ids.has(field.id)) throw new AppError('Checklist field IDs must be unique safe identifiers.');
    ids.add(field.id);
    if (!['text', 'enum', 'availability'].includes(field.type) || typeof field.label !== 'string' || !field.label || typeof field.question !== 'string' || !field.question || typeof field.description !== 'string') throw new AppError(`Invalid checklist field: ${field.id}.`);
    if (!['project_discussion', 'booking_requested'].includes(field.askWhen) || !Number.isFinite(field.priority)) throw new AppError(`Invalid ask condition or priority: ${field.id}.`);
    for(const condition of [field.whenQuestionnaire,field.skipWhenQuestionnaire])if(condition && (typeof condition.questionId!=='string'||!Array.isArray(condition.values)||!condition.values.length||condition.values.some(v=>!['yes','no','unknown'].includes(v))))throw new AppError('Invalid questionnaire condition.');
    if(field.answeredByQuestionnaire !== undefined && typeof field.answeredByQuestionnaire!=='string')throw new AppError('Invalid answered-by reference.');
    if (field.type === 'enum' && (!Array.isArray(field.options) || !field.options.length || field.options.some(value => typeof value !== 'string' || value.length > 100))) throw new AppError(`Enum options missing for ${field.id}.`);
  }
  if (schema.defaults?.maxQuestionsPerTurn !== 1) throw new AppError('This low-friction workflow asks at most one question per turn.');
  const readiness = schema.defaults.consultationReadiness;
  const form = schema.defaults.shortFormOffer;
  if (form && (typeof form.enabled !== 'boolean' || !Number.isInteger(form.afterCustomerMessages) || form.afterCustomerMessages < 1 || !Number.isInteger(form.minimumMissingFields) || form.minimumMissingFields < 1 || form.minimumMissingFields > schema.fields.length)) throw new AppError('Invalid proactive form offer rule.');
  if (readiness && (!Array.isArray(readiness.fields) || !readiness.fields.length || readiness.fields.some(id=>!ids.has(id)) || !Number.isInteger(readiness.minimumConfirmedFields) || readiness.minimumConfirmedFields < 0 || readiness.minimumConfirmedFields > readiness.fields.length)) throw new AppError('Invalid consultation readiness rule.');
  return schema;
}
export function createConfig(directory) {
  let current;
  const load = name => JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
  function reload() {
    try {
      const next = { schema: validateSchema(load('qualification.schema.json')), business: load('business-profile.json'), templates: load('message-templates.json'), defaults: load('acquisition-settings.json'), demoRules: load('demo-extraction.json').rules, quickReplies: validateReplyOptions(load('quick-replies.json')), questionnaire: load('reference-questionnaire.json'), safety: validateSafetyPolicy(load('safety-policy.json')) };
      if (next.questionnaire.version !== 1 || !Array.isArray(next.questionnaire.questions) || new Set(next.questionnaire.questions.map(q=>q.id)).size !== next.questionnaire.questions.length || next.questionnaire.questions.some(q=>!/^[a-z][a-z0-9_]{0,49}$/.test(q.id) || typeof q.question !== 'string' || typeof q.enabled !== 'boolean' || (q.formEnabled !== undefined && typeof q.formEnabled !== 'boolean') || (q.formQuestion !== undefined && (typeof q.formQuestion !== 'string' || !q.formQuestion.trim())))) throw new Error('Invalid reference questionnaire.');
      if(next.schema.fields.some(f=>[f.whenQuestionnaire?.questionId,f.skipWhenQuestionnaire?.questionId,f.answeredByQuestionnaire].filter(Boolean).some(id=>!next.questionnaire.questions.some(q=>q.id===id))))throw new Error('Checklist references an unknown questionnaire question.');
      if (!next.business.name || !Array.isArray(next.business.serviceAreas) || !next.templates.intro) throw new Error('Business profile or message templates are incomplete.');
      if (!Number.isFinite(next.business.meetingMinutes) || next.business.meetingMinutes < 15 || next.business.meetingMinutes > 240) throw new Error('Meeting duration must be 15–240 minutes.');
      if (next.business.meetingStartTimes && (!Array.isArray(next.business.meetingStartTimes) || !next.business.meetingStartTimes.length || next.business.meetingStartTimes.some(t => !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(t)))) throw new Error('Meeting start times must use HH:mm.');
      if (next.business.meetingWeekdays && (!Array.isArray(next.business.meetingWeekdays) || !next.business.meetingWeekdays.length || next.business.meetingWeekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6))) throw new Error('Meeting weekdays must be 0–6.');
      if (next.business.bookingHorizonDays && (!Number.isInteger(next.business.bookingHorizonDays) || next.business.bookingHorizonDays < 1 || next.business.bookingHorizonDays > 30)) throw new Error('Booking horizon must be 1–30 days.');
      new Intl.DateTimeFormat('en-US', { timeZone: next.business.timezone }).format(new Date());
      current = { ...next, loadedAt: new Date().toISOString() };
      return current;
    } catch (error) { throw new AppError(`Configuration rejected; last valid version retained. ${error.message}`); }
  }
  reload();
  return { get: () => current, reload, directory };
}
