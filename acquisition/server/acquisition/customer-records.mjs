// Team-only exports: current project context, with evidence and history preserved.
export function customerRecord({contact,project,conversation,config,messages,bookings,handoffs,comments}) {
  return {
    customer:{name:contact.name,instagram:contact.handle,source:contact.source,developerTest:Boolean(contact.developerTest||conversation.developerTestRound),doNotContact:contact.doNotContact},
    project:{id:project.id,title:project.title,stage:project.stage,owner:project.owner,lossReason:project.lossReason||null},
    facts:config.schema.fields.map(f=>({fieldId:f.id,field:f.label,...(project.facts[f.id]||{status:'not_shared',value:null})})),
    questionnaire:Object.entries(project.questionnaireAnswers||{}).map(([id,a])=>({questionId:id,question:config.questionnaire.questions.find(q=>q.id===id)?.question||id,...a})),
    appointments:bookings.map(b=>({status:b.status,start:b.start,end:b.end,timezone:b.timezone,rescheduleHistory:b.rescheduleHistory||[],changeStatus:b.rescheduleAttempt?.status||null})),
    teamRequests:handoffs.map(h=>({reason:h.reason,scope:h.scope,status:h.status,answer:h.answer||null,requestedAt:h.createdAt})),
    attachments:project.attachments||[],stageHistory:project.stageHistory||[],factHistory:project.factHistory||[],questionnaireHistory:project.questionnaireHistory||[],
    sourcePostId:conversation.sourcePostId||null,
    acquisitionComments:comments.map(c=>({text:c.text,mediaId:c.mediaId,createdAt:c.createdAt})),
    conversation:messages.map(m=>({at:m.sentAt||m.createdAt,author:m.author,direction:m.direction,status:m.status,text:m.text})).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))
  };
}
export function customerRecordText(r) {
 const heading=s=>`\n${s}\n${'-'.repeat(s.length)}`;
 const lines=['CUSTOMER PROJECT RECORD',`${r.customer.name} · @${r.customer.instagram}`,`Source: ${r.customer.source}`,`Project: ${r.project.title}`,`Stage: ${r.project.stage}`,`Owner: ${r.project.owner}`,`Developer test: ${r.customer.developerTest?'Yes':'No'}`,`Do not contact: ${r.customer.doNotContact?'Yes':'No'}`,heading('PROJECT DETAILS'),...r.facts.map(f=>`${f.field}: ${f.value??'Not shared'} (${f.status})`),heading('REFERENCE QUESTIONNAIRE'),...r.questionnaire.map(q=>`${q.question}\nAnswer: ${q.value}`),heading('APPOINTMENTS'),...r.appointments.map(b=>`${b.start} to ${b.end} · ${b.timezone} · ${b.status}${b.changeStatus?' · Change: '+b.changeStatus:''}`),heading('TEAM REQUESTS'),...r.teamRequests.map(h=>`${h.status} · ${h.reason}${h.answer?'\nTeam answer: '+h.answer:''}`),heading('CONVERSATION'),...r.conversation.map(m=>`[${m.at}] ${m.author} (${m.status})\n${m.text}`),heading('FULL COLLECTED RECORD AND HISTORY'),JSON.stringify(r,null,2)];
 return lines.join('\n');
}
