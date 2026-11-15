/**
 * Stages shared by the Node.js runtime (src/index.js) and the n8n workflow.
 *
 * Generation (webhook): ingest -> loadDeal -> plan -> document -> crmSync -> notify -> finalize
 * Monitoring (weekly):  monitorCollect -> monitorAct (per deal)
 *
 * Every stage takes and returns JSON-serializable data. Generation stages skip
 * themselves once the status is no longer "accepted", so any failure flows
 * straight to the response.
 */
import crypto from 'node:crypto';
import { isPlaceholderSetting, validateMapConfig } from './config.js';
import { evaluateMilestones, PlanError, resolveStakeholders, scheduleMilestones, toIsoDate } from './milestones.js';
import { buildMapModel, createMapDocument } from './mapDocument.js';
import { createMapHubSpotClient, dealPropertiesToRead, hubspotDealUrl } from './hubspot.js';
import { buildClientNudgeMessage, buildMapCreatedMessage, buildSlipAlertMessage, createMapSlackClient } from './slack.js';

export function createMapClients(config, { fetchImpl, sleep, offlineDeals } = {}) {
  return {
    hubspot: createMapHubSpotClient({
      token: config.hubspot.token,
      dryRun: config.dryRun,
      sandboxMode: config.sandboxMode,
      sandboxPortalId: config.hubspot.sandboxPortalId,
      baseUrl: config.hubspot.baseUrl,
      fetchImpl,
      ...(sleep ? { sleep } : {}),
      ...(offlineDeals ? { offlineDeals } : {}),
    }),
    slack: createMapSlackClient({ config, fetchImpl }),
  };
}

function headerValue(headers, name) {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  return null;
}

function secretsMatch(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Accepts HubSpot workflow webhooks (objectId / hs_object_id) and app webhook event arrays. */
export function extractDealId(payload) {
  const candidates = [];
  const pick = (p) => {
    if (!p || typeof p !== 'object') return;
    candidates.push(p.dealId, p.objectId, p.hs_object_id);
    const props = p.properties || {};
    const hsId = props.hs_object_id;
    candidates.push(hsId && typeof hsId === 'object' ? hsId.value : hsId);
  };
  if (Array.isArray(payload)) payload.filter((e) => !e.subscriptionType || String(e.subscriptionType).startsWith('deal.')).forEach(pick);
  else pick(payload);
  const found = candidates.find((c) => c !== undefined && c !== null && /^\d{1,20}$/.test(String(c)));
  return found ? String(found) : null;
}

function stop(ctx, status, httpStatus, reason, error) {
  return { ...ctx, status, httpStatus, reason, error: error ? String(error).slice(0, 300) : null };
}

export async function ingestMapStage(input, { config, now = Date.now() }) {
  const base = { status: 'accepted', httpStatus: 200, reason: null, receivedAt: new Date(now).toISOString(), dryRun: config.dryRun, sandboxMode: config.sandboxMode, warnings: [] };
  const check = validateMapConfig(config);
  if (check.errors.length) return stop({ ...base, errors: check.errors }, 'failed', 500, 'config_invalid');
  base.warnings = check.warnings;
  const raw = typeof input.rawBody === 'string' ? input.rawBody : JSON.stringify(input.body ?? {});
  if (Buffer.byteLength(raw, 'utf8') > config.webhook.maxBodyBytes) return stop(base, 'rejected', 413, 'payload_too_large');
  if (!isPlaceholderSetting(config.webhook.secret)) {
    if (!secretsMatch(headerValue(input.headers, config.webhook.secretHeader), config.webhook.secret)) return stop(base, 'rejected', 401, 'invalid_webhook_secret');
  }
  let payload;
  try {
    payload = typeof input.rawBody === 'string' ? JSON.parse(input.rawBody) : input.body;
  } catch {
    return stop(base, 'rejected', 400, 'invalid_json');
  }
  const dealId = extractDealId(payload);
  if (!dealId) return stop(base, 'rejected', 422, 'deal_id_missing');
  const keep = Array.isArray(payload) ? {} : { properties: payload.properties, offline: payload.offline, force: payload.force === true };
  return { ...base, dealId, payload: keep };
}

export async function loadDealStage(ctx, { config, hubspot }) {
  if (ctx.status !== 'accepted') return ctx;
  try {
    const bundle = await hubspot.getDealBundle(ctx.dealId, { properties: dealPropertiesToRead(config.schedule.template), payload: ctx.payload });
    if (!bundle) return stop(ctx, 'ignored', 404, 'deal_not_found');
    const p = bundle.deal.properties;
    const stageOk = !p.dealstage || config.trigger.stageIds.includes(String(p.dealstage));
    if (!stageOk) return stop({ ...ctx, bundle }, 'ignored', 200, 'stage_not_targeted');
    if (String(p.hs_is_closed) === 'true') return stop({ ...ctx, bundle }, 'ignored', 200, 'deal_closed');
    if (p.map_document_url && p.map_status === 'active' && !config.trigger.regenerateExisting && !ctx.payload.force) {
      return stop({ ...ctx, bundle }, 'ignored', 200, 'map_already_exists');
    }
    return { ...ctx, bundle };
  } catch (err) {
    return stop(ctx, 'failed', err.code === 'sandbox_portal_mismatch' || err.code === 'sandbox_account_required' ? 503 : 502, `hubspot_read_${err.code || 'error'}`, err.message);
  }
}

export async function planStage(ctx, { config, now = Date.now() }) {
  if (ctx.status !== 'accepted') return ctx;
  const { deal, company, contacts, owner } = ctx.bundle;
  const todayIso = new Date(now).toISOString().slice(0, 10);
  try {
    const plan = scheduleMilestones({
      template: config.schedule.template,
      startIso: todayIso,
      closeIso: toIsoDate(deal.properties.closedate),
      holidays: config.schedule.holidays,
      minRunwayBusinessDays: config.schedule.minRunwayBusinessDays,
    });
    const stakeholders = resolveStakeholders(contacts);
    const model = buildMapModel({ deal, company, owner, plan, stakeholders, config, generatedAt: new Date(now).toISOString() });
    const warnings = [...ctx.warnings];
    if (plan.shortRunway) warnings.push(`Only ${plan.runwayBusinessDays} business days until close`);
    if (!contacts.length) warnings.push('No contacts associated with the deal: customer owners are "To be confirmed"');
    return { ...ctx, plan, model, warnings };
  } catch (err) {
    if (err instanceof PlanError) return stop(ctx, 'failed', 422, `plan_${err.code}`, err.message);
    throw err;
  }
}

export async function documentStage(ctx, { config, fetchImpl }) {
  if (ctx.status !== 'accepted') return ctx;
  try {
    const document = await createMapDocument(ctx.model, { config, fetchImpl });
    return { ...ctx, document };
  } catch (err) {
    return stop(ctx, 'failed', err.code && /missing|invalid/.test(err.code) ? 503 : 502, `document_${err.code || 'error'}`, err.message);
  }
}

export function buildMapDealProperties(ctx) {
  const props = {
    map_document_url: ctx.document.url,
    map_status: 'active',
    map_generated_at: ctx.model.generatedAt,
    map_slipped_milestones: '',
  };
  for (const m of ctx.plan.milestones) {
    props[`map_${m.key}_date`] = m.targetDate;
    props[`map_${m.key}_done`] = 'false';
  }
  const next = ctx.plan.milestones[0];
  props.map_next_milestone = next ? next.name : '';
  props.map_next_milestone_date = next ? next.targetDate : '';
  return props;
}

export async function crmSyncStage(ctx, { hubspot }) {
  if (ctx.status !== 'accepted') return ctx;
  const properties = buildMapDealProperties(ctx);
  try {
    const result = await hubspot.updateDeal(ctx.dealId, properties);
    return { ...ctx, crm: { mode: result.mode, environment: result.environment || null, properties } };
  } catch (err) {
    return stop({ ...ctx, crm: { mode: 'error', properties } }, 'failed', err.code && err.code.startsWith('sandbox') ? 503 : 502, `hubspot_write_${err.code || 'error'}`, err.message);
  }
}

export async function notifyMapStage(ctx, { config, slack }) {
  const created = ctx.status === 'accepted' && ctx.document;
  if (!created || !config.slack.announceNewMaps) return { ...ctx, slack: { mode: 'skipped' } };
  const message = buildMapCreatedMessage({
    model: ctx.model,
    documentUrl: ctx.document.url,
    dealUrl: hubspotDealUrl(config.hubspot.appBaseUrl, config.hubspot.portalId, ctx.dealId),
    ownerId: ctx.bundle.deal.properties.hubspot_owner_id,
    config,
  });
  try {
    return { ...ctx, slack: await slack.send(message) };
  } catch (err) {
    return { ...ctx, slack: { mode: 'error', code: err.code || null }, warnings: [...ctx.warnings, `Slack: ${String(err.message).slice(0, 200)}`] };
  }
}

export function finalizeMapStage(ctx) {
  const status = ctx.status === 'accepted' ? 'generated' : ctx.status;
  return {
    httpStatus: ctx.httpStatus,
    body: {
      status,
      reason: ctx.reason || null,
      error: ctx.error || null,
      errors: ctx.errors || [],
      dryRun: ctx.dryRun,
      sandboxMode: ctx.sandboxMode,
      dealId: ctx.dealId || null,
      compressed: ctx.plan ? ctx.plan.compressed : null,
      milestones: ctx.plan ? ctx.plan.milestones.map((m) => ({ key: m.key, name: m.name, targetDate: m.targetDate, owner: m.owner })) : null,
      document: ctx.document ? { provider: ctx.document.provider, mode: ctx.document.mode, url: ctx.document.url } : null,
      crm: ctx.crm ? { mode: ctx.crm.mode, properties: ctx.dryRun ? ctx.crm.properties : undefined } : null,
      slack: ctx.slack || null,
      warnings: ctx.warnings || [],
    },
    preview: ctx.document && ctx.document.markdown ? ctx.document.markdown : null,
  };
}

/** Node.js mirror of the generation branch of the n8n workflow. */
export async function generateMap(input, { config, fetchImpl = globalThis.fetch, clients, now = () => Date.now() }) {
  const { hubspot, slack } = clients || createMapClients(config, { fetchImpl });
  let ctx = await ingestMapStage(input, { config, now: now() });
  ctx = await loadDealStage(ctx, { config, hubspot });
  ctx = await planStage(ctx, { config, now: now() });
  ctx = await documentStage(ctx, { config, fetchImpl });
  ctx = await crmSyncStage(ctx, { hubspot });
  ctx = await notifyMapStage(ctx, { config, slack });
  return finalizeMapStage(ctx);
}

export async function monitorCollectStage({ config, hubspot, now = Date.now() }) {
  const check = validateMapConfig(config);
  if (check.errors.length) return { status: 'failed', reason: 'config_invalid', errors: check.errors, items: [] };
  const todayIso = new Date(now).toISOString().slice(0, 10);
  const properties = dealPropertiesToRead(config.schedule.template);
  const deals = await hubspot.searchActiveMapDeals({ properties, maxDeals: config.monitor.maxDeals });
  const cooldownMs = config.monitor.nudgeCooldownDays * 24 * 3600 * 1000;
  const items = deals.map((deal) => {
    const evaluation = evaluateMilestones({
      dealProperties: deal.properties,
      template: config.schedule.template,
      todayIso,
      holidays: config.schedule.holidays,
      dueSoonBusinessDays: config.monitor.dueSoonBusinessDays,
    });
    const lastNudge = Date.parse(deal.properties.map_last_nudge_at || '');
    return {
      todayIso,
      deal: { id: String(deal.id), properties: deal.properties },
      evaluation,
      closed: String(deal.properties.hs_is_closed) === 'true',
      inCooldown: Number.isFinite(lastNudge) && now - lastNudge < cooldownMs,
    };
  });
  return { status: 'collected', todayIso, items, warnings: check.warnings };
}

export async function monitorActStage(item, { config, hubspot, slack, now = Date.now() }) {
  if (!item || !item.deal) return { skipped: true, status: (item && item.status) || 'no_deal', reason: (item && item.reason) || null };
  const { deal, evaluation } = item;
  const result = { dealId: deal.id, slipped: evaluation.slipped.map((i) => i.key), alert: null, clientNudge: null, crm: null, notes: [] };
  const props = {};
  if (item.closed || evaluation.allDone) {
    props.map_status = 'completed';
    result.notes.push(item.closed ? 'deal closed: MAP marked completed' : 'all milestones done: MAP marked completed');
  } else {
    props.map_next_milestone = evaluation.next ? evaluation.next.name : '';
    props.map_next_milestone_date = evaluation.next ? evaluation.next.targetDate : '';
    props.map_slipped_milestones = evaluation.slipped.map((i) => i.name).join('; ');
    if (evaluation.slipped.length && item.inCooldown) result.notes.push('nudge skipped: cooldown');
    if (evaluation.slipped.length && !item.inCooldown) {
      const dealUrl = hubspotDealUrl(config.hubspot.appBaseUrl, config.hubspot.portalId, deal.id);
      try {
        result.alert = await slack.send(buildSlipAlertMessage({ deal, evaluation, dealUrl, config }));
      } catch (err) {
        result.alert = { mode: 'error', code: err.code || null };
      }
      const channel = deal.properties.map_slack_connect_channel_id;
      if (config.slack.clientNudgesEnabled && evaluation.clientSlipped.length && channel) {
        try {
          result.clientNudge = await slack.send(buildClientNudgeMessage({ deal, evaluation, config }), { channelOverride: channel });
        } catch (err) {
          result.clientNudge = { mode: 'error', code: err.code || null };
        }
      } else if (evaluation.clientSlipped.length) {
        result.clientNudge = { mode: config.slack.clientNudgesEnabled ? 'no_shared_channel' : 'disabled' };
      }
      if (result.alert && ['sent', 'intercepted_dry_run'].includes(result.alert.mode)) props.map_last_nudge_at = new Date(now).toISOString();
    }
  }
  try {
    result.crm = await hubspot.updateDeal(deal.id, props);
  } catch (err) {
    result.crm = { mode: 'error', code: err.code || null };
  }
  result.properties = props;
  return result;
}

/** Node.js mirror of the monitoring branch of the n8n workflow. */
export async function runMonitor({ config, fetchImpl = globalThis.fetch, clients, now = () => Date.now() }) {
  const { hubspot, slack } = clients || createMapClients(config, { fetchImpl });
  const collected = await monitorCollectStage({ config, hubspot, now: now() });
  const results = [];
  for (const item of collected.items) results.push(await monitorActStage(item, { config, hubspot, slack, now: now() }));
  return {
    status: collected.status,
    reason: collected.reason || null,
    dryRun: config.dryRun,
    sandboxMode: config.sandboxMode,
    today: collected.todayIso || null,
    dealsChecked: collected.items.length,
    dealsSlipping: results.filter((r) => r.slipped.length).length,
    results,
    errors: collected.errors || [],
  };
}
