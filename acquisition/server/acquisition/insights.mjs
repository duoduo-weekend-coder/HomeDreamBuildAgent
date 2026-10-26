// Acquisition activity covers inbound conversations as well as first outreach.
// Contacts are counted once per metric; reset test projects never leak into a new round.
export function summarizeAcquisition({ contacts, projects, messages, comments, bookings, archivedTestRounds = 0 }) {
  const delivered = status => ['sent', 'simulated_sent'].includes(status);
  const currentProjects = projects.filter(p => !p.archivedTest);
  const projectIds = new Set(currentProjects.map(p => p.id));
  const active = record => !record.archivedTest && (!record.projectId || projectIds.has(record.projectId));
  const inbound = messages.filter(m => active(m) && m.direction === 'inbound' && m.author === 'customer' && m.status === 'received');
  const sent = messages.filter(m => active(m) && m.direction === 'outbound' && delivered(m.status));
  const currentComments = comments.filter(active);
  const confirmedBookings = bookings.filter(b => active(b) && ['confirmed', 'simulated'].includes(b.status));
  const people = contacts.map(c => {
    const ownProjects = currentProjects.filter(p => p.contactId === c.id);
    const ownComments = currentComments.filter(m => m.contactId === c.id);
    return {
      contactId: c.id, name: c.name, handle: c.handle,
      developerTest: Boolean(c.developerTest || c.conversation?.developerTestRound), testRound: c.conversation?.developerTestRound || 0,
      stage: c.project?.stage || ownProjects[0]?.stage || 'prospect',
      driveRecord:c.driveRecord||null,
      replied: sent.some(m=>m.contactId===c.id) && inbound.some(m=>m.contactId===c.id),
      meetings: confirmedBookings.filter(b=>b.contactId===c.id).map(b=>({start:b.start,end:b.end,timezone:b.timezone,status:b.status,changeStatus:b.rescheduleAttempt?.status||null})),
      dm: inbound.some(m => m.contactId === c.id),
      commented: ownComments.length > 0,
      privateInvitation: ownComments.some(m => delivered(m.private?.status)),
      formOffered: sent.some(m => m.contactId === c.id && m.formOffered),
      formSubmitted: ownProjects.some(p => p.intakeSubmittedAt),
      discovery: ownProjects.some(p => Object.keys(p.facts || {}).length || Object.keys(p.questionnaireAnswers || {}).length),
      qualified: ownProjects.some(p => p.qualifiedAt),
      booked: confirmedBookings.some(b => b.contactId === c.id),
      highIntent: c.signals?.intent === 'high',
      referenceAnswers: ownProjects.reduce((n, p) => n + Object.keys(p.questionnaireAnswers || {}).length, 0)
    };
  });
  function count(rows) {
    const n = key => rows.filter(c => c[key]).length;
    const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
    const dm = n('dm'), offered = n('formOffered');
    return {
      contacts: rows.length, dm, replied:n('replied'), commenters: n('commented'), privateInvitations: n('privateInvitation'),
      discovery: n('discovery'), qualified: n('qualified'), highIntent: n('highIntent'),
      formOffered: offered, formsSubmitted: n('formSubmitted'), booked: n('booked'),
      dmToDiscoveryRate: ratio(rows.filter(c => c.dm && c.discovery).length, dm),
      dmToBookingRate: ratio(rows.filter(c => c.dm && c.booked).length, dm),
      formCompletionRate: ratio(rows.filter(c => c.formOffered && c.formSubmitted).length, offered),
      people: rows
    };
  }
  return {
    all: count(people), customers: count(people.filter(c => !c.developerTest)), developerTests: count(people.filter(c => c.developerTest)),
    archivedTestRounds,
    note: 'Unique contacts per metric across direct DMs, comments and outreach. Developer tests show the latest round only. Bookings require a confirmed result; form submissions do not count as DMs.'
  };
}
