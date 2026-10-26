import { randomUUID } from 'node:crypto';
import { AppError } from '../domain.mjs';

export function validateReplyOptions(config) {
  if (config.version !== 1 || !config.fields || !Array.isArray(config.unknown)) throw new AppError('Invalid quick-reply configuration.');
  for (const options of [config.unknown, config.consultation, config.intro, config.form, ...Object.values(config.fields)]) {
    if (!Array.isArray(options) || options.length > 13) throw new AppError('Use at most 13 quick replies.');
    for (const o of options) if (!o.title || Object.values(o.title).some(t => typeof t !== 'string' || !t || [...t].length > 20) || !o.action || !['field','consultation','intent','form'].includes(o.action.type)) throw new AppError('Invalid quick-reply title or action.');
  }
  return config;
}
export function makeQuickReplies({ config, questionField, referenceQuestion, consultationOffered, formOffered, slots, intro, text, conversation }) {
  const language = /[\u3400-\u9fff]/u.test(text) ? 'zh' : 'en';
  let choices = [];
  if (slots?.length) choices = slots.slice(0, 13).map((slot, i) => ({ title: `${String.fromCharCode(65 + i)} · ${new Date(slot.start).toLocaleString('en-US', { timeZone: slot.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`.slice(0,20), action: { type: 'slot', slotId: slot.id } }));
  else if (referenceQuestion) choices = [{ title: language === 'zh' ? '是' : 'Yes', value: 'yes' }, { title: language === 'zh' ? '否' : 'No', value: 'no' }, { title: language === 'zh' ? '还不确定' : 'Not sure yet', value: 'unknown' }].map(o => ({ title: o.title, action: { type: 'questionnaire', questionId: referenceQuestion, value: o.value } }));
  else {
    const options = formOffered ? config.quickReplies.form : consultationOffered ? config.quickReplies.consultation : questionField ? config.quickReplies.fields[questionField] || config.quickReplies.unknown : intro ? config.quickReplies.intro : [];
    choices = options.map(o => ({ title: o.title[language] || o.title.en, action: { ...o.action, ...(o.action.type === 'field' ? { fieldId: questionField } : {}) } }));
  }
  return choices.map(o => ({ ...o, payload: `choice:${randomUUID()}`, projectId: conversation.projectId, ownershipVersion: conversation.ownershipVersion }));
}

export function resolveQuickReply({ payload, text, messages, conversation, config, allowMockTextSelection = false }) {
  const sent = messages.filter(m => m.direction === 'outbound' && ['sent', 'simulated_sent'].includes(m.status)).reverse().sort((a,b) => Date.parse(b.sentAt || b.createdAt) - Date.parse(a.sentAt || a.createdAt) || b.sequence-a.sequence || b.replyToVersion-a.replyToVersion);
  const message = sent[0];
  const choice = message?.quickReplies?.find(c => payload ? c.payload === payload : allowMockTextSelection && c.title.toLowerCase() === String(text || '').trim().toLowerCase());
  if (!choice || choice.projectId !== conversation.projectId || choice.ownershipVersion !== conversation.ownershipVersion || message.replyToVersion !== conversation.messageVersion) return payload ? { invalid: true } : null;
  const a = choice.action;
  if (a.type === 'slot' && (Date.parse(conversation.slotsExpireAt || 0) <= Date.now() || !conversation.offeredSlots.some(s=>s.id === a.slotId))) return { invalid: true };
  if (a.type === 'field') {
    const f = config.schema.fields.find(f=>f.id === a.fieldId);
    if (!f || !['confirmed','unknown','declined'].includes(a.status) || (f.type === 'enum' && a.status === 'confirmed' && !f.options.includes(a.value))) return { invalid: true };
  }
  if (a.type === 'questionnaire' && !config.questionnaire.questions.some(q=>q.id === a.questionId && q.enabled)) return { invalid: true };
  return { ...a, title: choice.title, sourceMessageId: message.id };
}

export function instagramQuickReplies(choices = []) {
  if (!Array.isArray(choices) || choices.length > 13) throw new AppError('Invalid quick replies.');
  return choices.map(c => {
    if (typeof c.title !== 'string' || !c.title || [...c.title].length > 20 || typeof c.payload !== 'string' || Buffer.byteLength(c.payload) > 1000) throw new AppError('Invalid quick reply.');
    return { content_type: 'text', title: c.title, payload: c.payload };
  });
}
