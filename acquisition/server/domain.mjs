export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function requiredText(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`${name} is required (maximum ${max} characters).`);
  return value.trim();
}
export function optionalText(value, max = 2000) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) throw new AppError(`Text must be at most ${max} characters.`);
  return value.trim();
}
export function validateProject(input, pricing) {
  const projectType = requiredText(input.projectType, 'Project type');
  const finish = requiredText(input.finish, 'Finish');
  const site = requiredText(input.site, 'Site condition');
  if (!Object.hasOwn(pricing.types, projectType)) throw new AppError('Choose a supported project type.');
  if (!Object.hasOwn(pricing.finishMultipliers, finish)) throw new AppError('Choose a finish level.');
  if (!Object.hasOwn(pricing.siteAllowances, site)) throw new AppError('Choose a site condition.');
  const areaSqft = Number(input.areaSqft);
  if (!Number.isFinite(areaSqft) || areaSqft < 100 || areaSqft > 20000) throw new AppError('Floor area must be between 100 and 20,000 square feet.');
  return { projectType, finish, site, areaSqft, city: requiredText(input.city, 'City', 100), timeline: optionalText(input.timeline, 100), budget: optionalText(input.budget, 100), notes: optionalText(input.notes, 2000) };
}
export function calculateEstimate(project, pricing) {
  const spec = validateProject(project, pricing);
  const rate = pricing.types[spec.projectType];
  const multiplier = pricing.finishMultipliers[spec.finish];
  const construction = { key: 'construction', label: 'Construction allowance', low: Math.round(spec.areaSqft * rate.lowPerSqft * multiplier), high: Math.round(spec.areaSqft * rate.highPerSqft * multiplier) };
  const site = { key: 'site', label: 'Site allowance', ...pricing.siteAllowances[spec.site] };
  const planning = { key: 'planning', label: 'Design & planning allowance', low: Math.round(construction.low * pricing.planningPercent), high: Math.round(construction.high * pricing.planningPercent) };
  const subtotalLow = construction.low + site.low + planning.low;
  const subtotalHigh = construction.high + site.high + planning.high;
  const contingency = { key: 'contingency', label: 'Contingency allowance', low: Math.round(subtotalLow * pricing.contingencyPercent), high: Math.round(subtotalHigh * pricing.contingencyPercent) };
  const inServiceArea = pricing.serviceAreas.some(city => city.toLowerCase() === spec.city.toLowerCase());
  return {
    mode: pricing.mode, pricingVersion: pricing.version, currency: pricing.currency,
    low: subtotalLow + contingency.low, high: subtotalHigh + contingency.high,
    lines: [construction, site, planning, contingency], exclusions: pricing.exclusions,
    assumptions: [`${spec.areaSqft.toLocaleString('en-US')} sq ft of project floor area`, `${spec.finish} finish level`, `Site condition: ${spec.site}`, 'No automatic measurements from photographs'],
    reviewReasons: [...(spec.site === 'unknown' ? ['Site conditions need clarification'] : []), ...(!inServiceArea ? ['Location requires service-area review'] : [])],
    note: pricing.note, label: pricing.label
  };
}
export function validateContact(input) {
  const name = requiredText(input.name, 'Name', 100);
  const email = requiredText(input.email, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Enter a valid email address.');
  if (input.consent !== true) throw new AppError('Please agree to be contacted about this project.');
  return { name, email, phone: optionalText(input.phone, 40), consent: true };
}
export const LEAD_STAGES = ['new', 'qualified', 'consultation_requested', 'proposal', 'won', 'closed'];

export function routeLead(project, estimate, rules) {
  return {
    routing: estimate.reviewReasons.length ? 'Needs scope review' : 'Ready for qualification',
    owner: estimate.reviewReasons.length ? rules.reviewOwner : (rules.ownersByProjectType[project.projectType] || rules.defaultOwner)
  };
}
