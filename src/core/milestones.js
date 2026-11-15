/**
 * Business-day date math, backward milestone scheduling from the HubSpot close
 * date, stakeholder resolution from associated contacts, and milestone
 * evaluation (slipped / due soon / next) for the weekly monitor.
 *
 * All dates are calendar dates ("YYYY-MM-DD") computed in UTC, so the result
 * does not depend on the server's timezone.
 */

const DAY_MS = 24 * 3600 * 1000;

export function toIsoDate(value) {
  if (value === undefined || value === null || value === '') return null;
  let d;
  if (value instanceof Date) d = value;
  else if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) d = new Date(`${value}T00:00:00Z`);
  else d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function isoToMs(iso) {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function isBusinessDay(iso, holidays = []) {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.includes(iso);
}

/** Moves n business days forward (n > 0) or backward (n < 0). n = 0 returns the date unchanged. */
export function addBusinessDays(iso, n, holidays = []) {
  let ms = isoToMs(iso);
  let remaining = Math.abs(n);
  const step = n < 0 ? -DAY_MS : DAY_MS;
  while (remaining > 0) {
    ms += step;
    if (isBusinessDay(new Date(ms).toISOString().slice(0, 10), holidays)) remaining -= 1;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

export function rollBackToBusinessDay(iso, holidays = []) {
  let current = iso;
  while (!isBusinessDay(current, holidays)) current = new Date(isoToMs(current) - DAY_MS).toISOString().slice(0, 10);
  return current;
}

/** Business days strictly after `fromIso` up to and including `toIso` (negative when toIso is earlier). */
export function businessDaysBetween(fromIso, toIso, holidays = []) {
  if (fromIso === toIso) return 0;
  if (isoToMs(toIso) < isoToMs(fromIso)) return -businessDaysBetween(toIso, fromIso, holidays);
  let count = 0;
  for (let ms = isoToMs(fromIso) + DAY_MS; ms <= isoToMs(toIso); ms += DAY_MS) {
    if (isBusinessDay(new Date(ms).toISOString().slice(0, 10), holidays)) count += 1;
  }
  return count;
}

export class PlanError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PlanError';
    this.code = code;
  }
}

/**
 * Computes target dates. Close-anchored milestones count back from the close date
 * (rolled back to a business day); start-anchored ones count forward from today.
 * When the runway is too short for the template, milestones are spread evenly
 * between start and close (order preserved) and the plan is marked compressed.
 */
export function scheduleMilestones({ template, startIso, closeIso, holidays = [], minRunwayBusinessDays = 5 }) {
  if (!closeIso) throw new PlanError('close_date_missing', 'The deal has no close date');
  const closeBd = rollBackToBusinessDay(closeIso, holidays);
  const runway = businessDaysBetween(startIso, closeBd, holidays);
  if (runway < 1) throw new PlanError('close_date_in_past', `Close date ${closeIso} is not after ${startIso}`);
  const raw = template.map((m) => ({
    ...m,
    targetDate: m.anchor === 'start' ? addBusinessDays(startIso, m.offsetBusinessDays, holidays) : addBusinessDays(closeBd, -m.offsetBusinessDays, holidays),
  }));
  const earliest = addBusinessDays(startIso, 1, holidays);
  const outOfBounds = raw.some((m) => m.targetDate < earliest || m.targetDate > closeBd);
  const outOfOrder = raw.some((m, i) => i > 0 && m.targetDate < raw[i - 1].targetDate);
  let compressed = false;
  let milestones = raw;
  if (outOfBounds || outOfOrder) {
    compressed = true;
    milestones = raw.map((m, i) => {
      const position = Math.max(1, Math.round(((i + 1) * runway) / raw.length));
      return { ...m, targetDate: i === raw.length - 1 ? closeBd : addBusinessDays(startIso, Math.min(position, runway), holidays) };
    });
  }
  return {
    startDate: startIso,
    closeDate: closeIso,
    closeBusinessDate: closeBd,
    runwayBusinessDays: runway,
    compressed,
    shortRunway: runway < minRunwayBusinessDays,
    milestones: milestones.map((m) => ({
      key: m.key,
      name: m.name,
      description: m.description || '',
      owner: m.owner,
      internalRole: m.internalRole || 'ae',
      clientRole: m.clientRole || 'champion',
      targetDate: m.targetDate,
    })),
  };
}

const CLIENT_ROLE_RULES = {
  champion: { buying: ['CHAMPION'], title: /\b(?:champion|sponsor|project lead|program manager)\b/i },
  technical: { buying: ['END_USER', 'INFLUENCER'], title: /\b(?:cto|engineer\w*|architect|technical|technology|developer|devops|it\b|data|platform|systems)\b/i },
  security: { buying: [], title: /\b(?:security|ciso|infosec|compliance|risk|privacy)\b/i },
  procurement: { buying: ['LEGAL_AND_COMPLIANCE'], title: /\b(?:procurement|purchasing|legal|counsel|sourcing|vendor management|contracts?)\b/i },
  economic_buyer: { buying: ['BUDGET_HOLDER', 'DECISION_MAKER', 'EXECUTIVE_SPONSOR'], title: /\b(?:cfo|ceo|coo|cro|chief|vp|vice president|president|head of|director|owner|founder)\b/i },
};

function contactDisplayName(c) {
  const name = [c.firstname, c.lastname].filter(Boolean).join(' ').trim();
  return name || 'Unnamed contact';
}

/** Picks one associated contact per client role using hs_buying_role first, then job-title keywords. */
export function resolveStakeholders(contacts = []) {
  const people = contacts.map((c) => ({
    id: String(c.id),
    name: contactDisplayName(c),
    jobTitle: c.jobtitle || '',
    email: c.email || '',
    buyingRoles: String(c.hs_buying_role || '').split(';').map((r) => r.trim().toUpperCase()).filter(Boolean),
  }));
  const byRole = {};
  for (const [role, rule] of Object.entries(CLIENT_ROLE_RULES)) {
    const match =
      people.find((p) => p.buyingRoles.some((b) => rule.buying.includes(b))) ||
      people.find((p) => rule.title.test(p.jobTitle)) ||
      null;
    byRole[role] = match;
  }
  if (!byRole.champion) byRole.champion = people[0] || null;
  for (const role of Object.keys(byRole)) if (!byRole[role]) byRole[role] = byRole.champion;
  return { people, byRole };
}

/** Reads per-milestone date/done properties from a deal and classifies each open milestone. */
export function evaluateMilestones({ dealProperties, template, todayIso, holidays = [], dueSoonBusinessDays = 3 }) {
  const items = template.map((m) => {
    const targetDate = toIsoDate(dealProperties[`map_${m.key}_date`]);
    const done = String(dealProperties[`map_${m.key}_done`] || '').toLowerCase() === 'true';
    let state = 'scheduled';
    if (done) state = 'done';
    else if (!targetDate) state = 'unscheduled';
    else if (targetDate < todayIso) state = 'slipped';
    else if (businessDaysBetween(todayIso, targetDate, holidays) <= dueSoonBusinessDays) state = 'due_soon';
    const daysLate = state === 'slipped' ? businessDaysBetween(targetDate, todayIso, holidays) : 0;
    return { key: m.key, name: m.name, owner: m.owner, targetDate, done, state, daysLate };
  });
  const open = items.filter((i) => !i.done && i.targetDate).sort((a, b) => a.targetDate.localeCompare(b.targetDate));
  return {
    items,
    slipped: items.filter((i) => i.state === 'slipped'),
    clientSlipped: items.filter((i) => i.state === 'slipped' && (i.owner === 'client' || i.owner === 'both')),
    dueSoon: items.filter((i) => i.state === 'due_soon'),
    next: open[0] || null,
    allDone: items.every((i) => i.done),
  };
}
