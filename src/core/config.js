/**
 * Configuration shared by the Node.js runtime and the n8n workflow.
 *
 * Fail-safe rules:
 * - DRY_RUN and SANDBOX_MODE stay true unless explicitly set to false/0/no/off.
 * - Values like "your_..._here" count as "not configured".
 * - DOC_PROVIDER defaults to "stub": no document is created anywhere.
 * - Client-facing Slack nudges are off unless CLIENT_NUDGES_ENABLED=true.
 *
 * Embedded verbatim into the n8n Code nodes by scripts/build-workflow.js:
 * top-level names must be unique across src/core/.
 */

const MAP_PLACEHOLDER_RE = /^(?:|your_[a-z0-9_]*_here|changeme|change_me|placeholder|x{3,})$/i;

export const DEFAULT_MILESTONE_TEMPLATE = [
  {
    key: 'kickoff',
    name: 'MAP Kickoff & Success Criteria',
    anchor: 'start',
    offsetBusinessDays: 2,
    owner: 'both',
    internalRole: 'ae',
    clientRole: 'champion',
    description: 'Agree on the evaluation scope, success criteria and the dates in this plan.',
  },
  {
    key: 'technical_review',
    name: 'Technical Review',
    anchor: 'close',
    offsetBusinessDays: 25,
    owner: 'client',
    internalRole: 'se',
    clientRole: 'technical',
    description: 'Technical validation of integrations, data flows and architecture fit.',
  },
  {
    key: 'security_audit',
    name: 'Security Audit',
    anchor: 'close',
    offsetBusinessDays: 20,
    owner: 'client',
    internalRole: 'se',
    clientRole: 'security',
    description: 'Security questionnaire, documentation review and any vendor risk assessment.',
  },
  {
    key: 'final_proposal',
    name: 'Final Proposal',
    anchor: 'close',
    offsetBusinessDays: 15,
    owner: 'internal',
    internalRole: 'ae',
    clientRole: 'economic_buyer',
    description: 'Final commercial proposal reflecting the agreed scope.',
  },
  {
    key: 'legal_procurement',
    name: 'Legal & Procurement',
    anchor: 'close',
    offsetBusinessDays: 8,
    owner: 'client',
    internalRole: 'deal_desk',
    clientRole: 'procurement',
    description: 'Contract redlines, vendor onboarding and purchase order.',
  },
  {
    key: 'contract_signature',
    name: 'Contract Signature',
    anchor: 'close',
    offsetBusinessDays: 0,
    owner: 'client',
    internalRole: 'ae',
    clientRole: 'economic_buyer',
    description: 'Signature by the authorised signatory.',
  },
];

export function isPlaceholderSetting(value) {
  if (value === undefined || value === null) return true;
  return MAP_PLACEHOLDER_RE.test(String(value).trim());
}

/** true/1/yes/on -> true, false/0/no/off -> false, anything else -> the default. */
export function readFlag(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

function readInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readList(value, fallback = []) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function readJson(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return { __invalidJson: true };
  }
}

export function validateMilestoneTemplate(template) {
  const errors = [];
  if (!Array.isArray(template) || !template.length) return ['milestone template must be a non-empty array'];
  const keys = new Set();
  template.forEach((m, i) => {
    const where = `milestone[${i}]`;
    if (!m || typeof m !== 'object') {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(String(m.key || ''))) errors.push(`${where}.key must be lowercase snake_case (2-31 chars)`);
    if (keys.has(m.key)) errors.push(`${where}.key "${m.key}" is duplicated`);
    keys.add(m.key);
    if (!m.name) errors.push(`${where}.name is required`);
    if (!['start', 'close'].includes(m.anchor)) errors.push(`${where}.anchor must be "start" or "close"`);
    if (!Number.isInteger(m.offsetBusinessDays) || m.offsetBusinessDays < 0 || m.offsetBusinessDays > 250) {
      errors.push(`${where}.offsetBusinessDays must be an integer from 0 to 250`);
    }
    if (!['client', 'internal', 'both'].includes(m.owner)) errors.push(`${where}.owner must be client, internal or both`);
  });
  return errors;
}

export function loadMapConfig(env = {}) {
  const read = (key, fallback = '') => {
    const value = env[key];
    return value === undefined || value === null ? fallback : String(value).trim();
  };
  const docProvider = read('DOC_PROVIDER', 'stub').toLowerCase();
  const template = readJson(read('MILESTONE_TEMPLATE_JSON'), DEFAULT_MILESTONE_TEMPLATE);
  return {
    dryRun: readFlag(env.DRY_RUN, true),
    sandboxMode: readFlag(env.SANDBOX_MODE, true),
    timezoneNote: read('BUSINESS_TIMEZONE_LABEL', 'UTC'),
    webhook: {
      secret: read('N8N_WEBHOOK_SECRET'),
      secretHeader: read('WEBHOOK_SECRET_HEADER', 'x-webhook-secret').toLowerCase(),
      maxBodyBytes: readInt(env.WEBHOOK_MAX_BODY_BYTES, 262144),
    },
    trigger: {
      stageIds: readList(env.TRIGGER_STAGE_IDS, ['presentationscheduled']),
      regenerateExisting: readFlag(env.REGENERATE_EXISTING_MAP, false),
    },
    schedule: {
      holidays: readList(env.HOLIDAYS),
      template,
      minRunwayBusinessDays: readInt(env.MIN_RUNWAY_BUSINESS_DAYS, 5),
    },
    document: {
      provider: ['stub', 'google_docs', 'notion'].includes(docProvider) ? docProvider : 'invalid',
      sellerCompanyName: read('SELLER_COMPANY_NAME', 'Your Company'),
      includeAmount: readFlag(env.MAP_INCLUDE_AMOUNT, false),
      includeContactEmails: readFlag(env.MAP_INCLUDE_CONTACT_EMAILS, false),
      stubBaseUrl: read('STUB_DOC_BASE_URL', 'https://docs.example.com/maps'),
      internalRoleLabels: {
        ae: 'Account Executive',
        se: 'Solutions Engineer',
        deal_desk: 'Deal Desk',
        ...(readJson(read('INTERNAL_ROLE_LABELS_JSON'), {}) || {}),
      },
      google: {
        serviceAccountJson: read('GOOGLE_SERVICE_ACCOUNT_JSON'),
        folderId: read('GOOGLE_DRIVE_FOLDER_ID'),
        sandboxFolderId: read('GOOGLE_SANDBOX_FOLDER_ID'),
        scope: read('GOOGLE_DRIVE_SCOPE', 'https://www.googleapis.com/auth/drive.file'),
      },
      notion: {
        token: read('NOTION_API_TOKEN'),
        databaseId: read('NOTION_DATABASE_ID'),
        sandboxDatabaseId: read('NOTION_SANDBOX_DATABASE_ID'),
        titleProperty: read('NOTION_TITLE_PROPERTY', 'Name'),
        version: read('NOTION_API_VERSION', '2022-06-28'),
      },
    },
    hubspot: {
      token: read('HUBSPOT_PRIVATE_APP_TOKEN'),
      portalId: read('HUBSPOT_PORTAL_ID'),
      sandboxPortalId: read('HUBSPOT_SANDBOX_PORTAL_ID'),
      baseUrl: read('HUBSPOT_BASE_URL', 'https://api.hubapi.com'),
      appBaseUrl: read('HUBSPOT_APP_BASE_URL', 'https://app.hubspot.com'),
    },
    slack: {
      botToken: read('SLACK_BOT_TOKEN'),
      channelId: read('SLACK_CHANNEL_ID'),
      webhookUrl: read('SLACK_WEBHOOK_URL'),
      sandboxChannelId: read('SLACK_SANDBOX_CHANNEL_ID'),
      sandboxWebhookUrl: read('SLACK_SANDBOX_WEBHOOK_URL'),
      ownerSlackMap: readJson(read('OWNER_SLACK_MAP_JSON'), {}) || {},
      clientNudgesEnabled: readFlag(env.CLIENT_NUDGES_ENABLED, false),
      announceNewMaps: readFlag(env.ANNOUNCE_NEW_MAPS, true),
    },
    monitor: {
      nudgeCooldownDays: readInt(env.NUDGE_COOLDOWN_DAYS, 6),
      dueSoonBusinessDays: readInt(env.DUE_SOON_BUSINESS_DAYS, 3),
      maxDeals: readInt(env.MONITOR_MAX_DEALS, 500),
    },
  };
}

export function validateMapConfig(config) {
  const errors = [];
  const warnings = [];
  const live = !config.dryRun;
  if (config.schedule.template && config.schedule.template.__invalidJson) errors.push('MILESTONE_TEMPLATE_JSON is not valid JSON');
  else errors.push(...validateMilestoneTemplate(config.schedule.template));
  if (config.document.provider === 'invalid') errors.push('DOC_PROVIDER must be stub, google_docs or notion');
  for (const h of config.schedule.holidays) if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) errors.push(`HOLIDAYS entry "${h}" must be YYYY-MM-DD`);
  if (!config.trigger.stageIds.length) errors.push('TRIGGER_STAGE_IDS must list at least one deal stage ID');
  if (isPlaceholderSetting(config.webhook.secret)) {
    if (live) errors.push('N8N_WEBHOOK_SECRET is missing or a placeholder');
    else warnings.push('N8N_WEBHOOK_SECRET is a placeholder: webhook authentication is skipped in dry run');
  }
  if (live) {
    if (isPlaceholderSetting(config.hubspot.token)) errors.push('HUBSPOT_PRIVATE_APP_TOKEN is missing or a placeholder');
    if (config.document.provider === 'stub') warnings.push('DOC_PROVIDER=stub: deals receive a placeholder MAP URL');
    if (config.document.provider === 'google_docs') {
      if (isPlaceholderSetting(config.document.google.serviceAccountJson)) errors.push('GOOGLE_SERVICE_ACCOUNT_JSON is required for DOC_PROVIDER=google_docs');
      const folder = config.sandboxMode ? config.document.google.sandboxFolderId : config.document.google.folderId;
      if (isPlaceholderSetting(folder)) errors.push(config.sandboxMode ? 'GOOGLE_SANDBOX_FOLDER_ID is required in SANDBOX_MODE' : 'GOOGLE_DRIVE_FOLDER_ID is required');
    }
    if (config.document.provider === 'notion') {
      if (isPlaceholderSetting(config.document.notion.token)) errors.push('NOTION_API_TOKEN is required for DOC_PROVIDER=notion');
      const db = config.sandboxMode ? config.document.notion.sandboxDatabaseId : config.document.notion.databaseId;
      if (isPlaceholderSetting(db)) errors.push(config.sandboxMode ? 'NOTION_SANDBOX_DATABASE_ID is required in SANDBOX_MODE' : 'NOTION_DATABASE_ID is required');
    }
    if (!config.sandboxMode) warnings.push('SANDBOX_MODE=false and DRY_RUN=false: production HubSpot, documents and Slack are modified');
  }
  return { errors, warnings };
}
