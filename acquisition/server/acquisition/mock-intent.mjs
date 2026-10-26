// Offline demo/test fixture only. Never used by the Claude production route.
// These deterministic examples let tests run without API calls; they are not the intent policy.
import { emptyIntent } from './intent.mjs';
export function mockIntent(text,conversation={}) {
 const value=emptyIntent();
 value.booking=/\b(reschedule|another time)\b|改约|改期/.test(text.toLowerCase())?'reschedule':/\b(book|meeting|consultation|schedule|appointment|call)\b|预约|约时间|见面/i.test(text)?'book':'none';
 if(conversation.lastAssistantMeetingOffer&&/^(yes|sure|okay|ok|please)[.!\s]*$/i.test(text))value.booking='book';
 value.form=/\b(form|questionnaire)\b|填表|表单/i.test(text)?/\b(no|don.t|not).{0,20}(form|questionnaire)|不.{0,4}填|不要表/i.test(text)?'decline':'request':'none';
 value.human=/\b(human|real person|salesperson)\b|真人|人工/i.test(text)?/only.{0,20}(human|person)|stop.{0,20}(bot|assistant|automat)|不要机器人|停止自动回复/i.test(text)?'exclusive':'topic':'none';
 value.optOut=/^\s*stop[.!。\s]*$/i.test(text)||/\b(stop messaging|stop contacting|do not contact|don.t contact|unsubscribe|leave me alone)\b|别再联系|不要联系|退订/i.test(text);
 value.projectInterest=/\b(build|home|house|remodel|addition|project)\b|建房|项目|装修/i.test(text);
 value.browsingOnly=/\b(just browsing|inspiration|not ready)\b|随便看看|暂时没/i.test(text);
 value.commercialCommitment=/\b(contract|discount|guarantee)\b|合同|折扣|保证/i.test(text);
 if(/\b(chose|chosen|hired|going with)\b.{0,40}\b(another|different|other)\b|选了别家|找了其他公司/i.test(text))value.lostReason=text;
 const match=text.trim().match(/^(?:book\s+(?:option\s+)?|choose\s+|选\s*|预约\s*)?([abc123])(?:\s+please)?[.!。\s]*$/i);
 const index=match?/^[123]$/.test(match[1])?Number(match[1])-1:match[1].toUpperCase().charCodeAt(0)-65:/\b(first one|first option)\b|第一个/i.test(text)?0:/\b(second one|second option)\b|第二个/i.test(text)?1:/\b(third one|third option)\b|第三个/i.test(text)?2:-1;
 if(Date.parse(conversation.slotsExpireAt||0)>Date.now())value.slotId=conversation.offeredSlots?.[index]?.id||null;
 return value;
}
