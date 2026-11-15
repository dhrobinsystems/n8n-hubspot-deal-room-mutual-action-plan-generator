/**
 * Test suite (node --test). No network: HTTP goes through a recording fetch stub,
 * the server listens on an ephemeral localhost port, and the n8n Code nodes are
 * executed in-process and compared with the Node.js mirror.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MILESTONE_TEMPLATE, loadMapConfig, readFlag, validateMapConfig, validateMilestoneTemplate } from '../src/core/config.js';
import {
  addBusinessDays,
  businessDaysBetween,
  evaluateMilestones,
  isBusinessDay,
  resolveStakeholders,
  rollBackToBusinessDay,
  scheduleMilestones,
  toIsoDate,
} from '../src/core/milestones.js';
import { buildMapModel, createMapDocument, getGoogleAccessToken, renderMapHtml, renderMapMarkdown, renderMapNotionBlocks } from '../src/core/mapDocument.js';
import { createMapHubSpotClient } from '../src/core/hubspot.js';
import { createMapSlackClient } from '../src/core/slack.js';
import { createMapClients, extractDealId, generateMap, monitorCollectStage, monitorActStage, runMonitor } from '../src/core/pipeline.js';
import { createServer, runOfflineMonitor, runSimulation, SAMPLE_HOLIDAYS, simulationNow } from '../src/index.js';
import { buildWorkflow, serializeWorkflow } from '../scripts/build-workflow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'fixtures', name), 'utf8');
const WEBHOOK = fixture('sample-hubspot-webhook.json');
const ACTIVE_DEALS = JSON.parse(fixture('sample-active-deals.json'));
const TODAY = simulationNow({});
const T = DEFAULT_MILESTONE_TEMPLATE;

function recordingFetch(handler = () => ({ status: 200, body: {} })) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    let body = init.body;
    try {
      body = body ? JSON.parse(body) : undefined;
    } catch {
      // multipart / form bodies stay strings
    }
    const call = { url, method: init.method || 'GET', headers: init.headers || {}, body };
    calls.push(call);
    const { status = 200, body: resBody = {} } = (await handler(call)) || {};
    const text = typeof resBody === 'string' ? resBody : JSON.stringify(resBody);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
  };
  return { fetchImpl, calls };
}

const offlineClients = (config) => createMapClients(config, { fetchImpl: recordingFetch().fetchImpl, offlineDeals: ACTIVE_DEALS });
const cfg = (env = {}) => loadMapConfig({ HOLIDAYS: SAMPLE_HOLIDAYS, ...env });

describe('configuration', () => {
  test('safe defaults: dry run, sandbox, stub documents, client nudges off', () => {
    const c = loadMapConfig({});
    assert.equal(c.dryRun, true);
    assert.equal(c.sandboxMode, true);
    assert.equal(c.document.provider, 'stub');
    assert.equal(c.slack.clientNudgesEnabled, false);
    assert.equal(c.document.includeAmount, false);
    assert.equal(loadMapConfig({ DRY_RUN: 'flase' }).dryRun, true);
    assert.equal(readFlag('OFF', true), false);
  });

  test('live mode refuses placeholders and incomplete providers', () => {
    const { errors } = validateMapConfig(loadMapConfig({ DRY_RUN: 'false', DOC_PROVIDER: 'notion', N8N_WEBHOOK_SECRET: 'your_n8n_webhook_secret_here' }));
    for (const needle of ['N8N_WEBHOOK_SECRET', 'HUBSPOT_PRIVATE_APP_TOKEN', 'NOTION_API_TOKEN', 'NOTION_SANDBOX_DATABASE_ID']) {
      assert.ok(errors.some((e) => e.includes(needle)), needle);
    }
    assert.ok(validateMapConfig(loadMapConfig({ DOC_PROVIDER: 'word' })).errors.some((e) => e.includes('DOC_PROVIDER')));
    assert.ok(validateMapConfig(loadMapConfig({ HOLIDAYS: '25/12/2026' })).errors.some((e) => e.includes('HOLIDAYS')));
    assert.ok(validateMapConfig(loadMapConfig({ MILESTONE_TEMPLATE_JSON: '{nope' })).errors.some((e) => e.includes('not valid JSON')));
  });

  test('milestone template validation', () => {
    assert.deepEqual(validateMilestoneTemplate(T), []);
    const bad = validateMilestoneTemplate([{ key: 'Bad Key', name: '', anchor: 'mid', offsetBusinessDays: -1, owner: 'nobody' }, { key: 'Bad Key' }]);
    assert.ok(bad.length >= 5);
  });
});

describe('business-day math and backward scheduling', () => {
  test('business days, holidays and rollback', () => {
    assert.equal(isBusinessDay('2026-11-14'), false);
    assert.equal(isBusinessDay('2026-12-25', ['2026-12-25']), false);
    assert.equal(addBusinessDays('2026-11-13', 1), '2026-11-16');
    assert.equal(addBusinessDays('2026-11-16', -1), '2026-11-13');
    assert.equal(addBusinessDays('2026-12-24', 1, ['2026-12-25']), '2026-12-28');
    assert.equal(rollBackToBusinessDay('2026-11-15'), '2026-11-13');
    assert.equal(businessDaysBetween('2026-11-13', '2026-11-20'), 5);
    assert.equal(businessDaysBetween('2026-11-20', '2026-11-13'), -5);
    assert.equal(toIsoDate('1800000000000'), '2027-01-15');
    assert.equal(toIsoDate('2027-01-29T17:00:00Z'), '2027-01-29');
    assert.equal(toIsoDate('garbage'), null);
  });

  test('milestones count back from the close date and avoid weekends and holidays', () => {
    const plan = scheduleMilestones({ template: T, startIso: '2026-11-16', closeIso: '2027-01-29', holidays: SAMPLE_HOLIDAYS.split(',') });
    assert.equal(plan.compressed, false);
    const dates = Object.fromEntries(plan.milestones.map((m) => [m.key, m.targetDate]));
    assert.equal(dates.kickoff, '2026-11-18');
    assert.equal(dates.contract_signature, '2027-01-29');
    assert.equal(businessDaysBetween(dates.final_proposal, '2027-01-29', SAMPLE_HOLIDAYS.split(',')), 15);
    for (const d of Object.values(dates)) assert.ok(isBusinessDay(d, SAMPLE_HOLIDAYS.split(',')), d);
    const sorted = [...plan.milestones].map((m) => m.targetDate);
    assert.deepEqual(sorted, [...sorted].sort());
  });

  test('a weekend close date rolls back to Friday for the signature milestone', () => {
    const plan = scheduleMilestones({ template: T, startIso: '2026-11-16', closeIso: '2027-01-31' });
    assert.equal(plan.closeBusinessDate, '2027-01-29');
    assert.equal(plan.milestones.at(-1).targetDate, '2027-01-29');
  });

  test('short runway compresses in order; past close dates are refused', () => {
    const plan = scheduleMilestones({ template: T, startIso: '2026-11-16', closeIso: '2026-12-04' });
    assert.equal(plan.compressed, true);
    const dates = plan.milestones.map((m) => m.targetDate);
    assert.deepEqual(dates, [...dates].sort());
    assert.ok(dates.every((d) => d > '2026-11-16' && d <= '2026-12-04'));
    assert.throws(() => scheduleMilestones({ template: T, startIso: '2026-11-16', closeIso: '2026-11-10' }), (e) => e.code === 'close_date_in_past');
    assert.throws(() => scheduleMilestones({ template: T, startIso: '2026-11-16', closeIso: null }), (e) => e.code === 'close_date_missing');
    const tight = scheduleMilestones({ template: T, startIso: '2026-11-16', closeIso: '2026-11-17' });
    assert.ok(tight.milestones.every((m) => m.targetDate === '2026-11-17'));
    assert.equal(tight.shortRunway, true);
  });
});

describe('stakeholders and the MAP document', () => {
  const offline = JSON.parse(WEBHOOK).offline;
  const stakeholders = resolveStakeholders(offline.contacts);

  test('roles come from hs_buying_role first, then job titles, then the champion', () => {
    assert.equal(stakeholders.byRole.champion.name, 'Jane Doe');
    assert.equal(stakeholders.byRole.economic_buyer.name, 'John Smith');
    assert.equal(stakeholders.byRole.security.name, 'Priya Patel');
    assert.equal(stakeholders.byRole.procurement.name, 'Maria Garcia');
    assert.equal(stakeholders.byRole.technical.name, 'Sam Lee');
    const sparse = resolveStakeholders([{ id: '1', firstname: 'Only', lastname: 'Contact', jobtitle: 'Analyst' }]);
    assert.equal(sparse.byRole.security.name, 'Only Contact');
    assert.equal(resolveStakeholders([]).byRole.champion, null);
  });

  function model(env = {}) {
    const config = cfg(env);
    const plan = scheduleMilestones({ template: T, startIso: '2026-11-16', closeIso: '2027-01-29', holidays: config.schedule.holidays });
    const deal = { id: '1000000001', properties: { dealname: 'Acme Corp - Platform Rollout', amount: '48000', deal_currency_code: 'USD' } };
    return buildMapModel({ deal, company: offline.company, owner: offline.owner, plan, stakeholders, config, generatedAt: '2026-11-16T09:00:00.000Z' });
  }

  test('model: owners per side, amount and emails hidden by default', () => {
    const m = model();
    assert.equal(m.title, 'Mutual Action Plan: Acme Corp × Your Company');
    assert.equal(m.amount, null);
    const sig = m.milestones.find((x) => x.key === 'contract_signature');
    assert.equal(sig.clientOwner, 'John Smith (Chief Financial Officer)');
    assert.equal(sig.internalOwner, 'Alex Rivera (support)');
    assert.equal(m.milestones.find((x) => x.key === 'final_proposal').clientOwner, '—');
    assert.ok(!JSON.stringify(m).includes('@acme.example'));
    const withExtras = model({ MAP_INCLUDE_AMOUNT: 'true', MAP_INCLUDE_CONTACT_EMAILS: 'true', SELLER_COMPANY_NAME: 'Example Seller' });
    assert.equal(withExtras.amount, '$48,000');
    assert.ok(JSON.stringify(withExtras).includes('jane.doe@acme.example'));
  });

  test('Markdown, HTML and Notion renderers', () => {
    const m = model();
    const md = renderMapMarkdown(m);
    assert.match(md, /\| 6 \| Contract Signature \| Fri, Jan 29, 2027 \|/);
    const html = renderMapHtml({ ...m, companyName: '<script>x</script>' });
    assert.ok(!html.includes('<script>x'));
    const blocks = renderMapNotionBlocks(m);
    assert.equal(blocks.filter((b) => b.type === 'to_do').length, 6);
    assert.ok(blocks.length <= 100);
  });

  test('stub provider and dry run never call out', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const stub = await createMapDocument(model(), { config: cfg(), fetchImpl });
    assert.equal(stub.mode, 'intercepted_dry_run');
    assert.match(stub.url, /^https:\/\/docs\.example\.com\/maps\/deal-1000000001\?dry_run=true$/);
    const notionDry = await createMapDocument(model(), { config: cfg({ DOC_PROVIDER: 'notion' }), fetchImpl });
    assert.equal(notionDry.mode, 'intercepted_dry_run');
    assert.equal(calls.length, 0);
  });

  test('Notion provider posts to the sandbox database in SANDBOX_MODE', async () => {
    const { fetchImpl, calls } = recordingFetch(() => ({ body: { id: 'page-1', url: 'https://www.notion.so/page-1' } }));
    const config = cfg({ DRY_RUN: 'false', DOC_PROVIDER: 'notion', NOTION_API_TOKEN: 'test-token', NOTION_DATABASE_ID: 'prod-db', NOTION_SANDBOX_DATABASE_ID: 'sandbox-db' });
    const doc = await createMapDocument(model(), { config, fetchImpl });
    assert.equal(doc.url, 'https://www.notion.so/page-1');
    assert.equal(calls[0].body.parent.database_id, 'sandbox-db');
    assert.equal(calls[0].headers['notion-version'], '2022-06-28');
  });

  test('Google Docs provider: service-account JWT, multipart HTML upload into the sandbox folder', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const serviceAccount = JSON.stringify({ client_email: 'map-bot@service-account.example', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    const { fetchImpl, calls } = recordingFetch((call) =>
      call.url.startsWith('https://oauth2.googleapis.com/token') ? { body: { access_token: 'ya29.test' } } : { body: { id: 'doc-123', webViewLink: 'https://docs.google.com/document/d/doc-123/edit' } },
    );
    const config = cfg({ DRY_RUN: 'false', DOC_PROVIDER: 'google_docs', GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount, GOOGLE_DRIVE_FOLDER_ID: 'prod-folder', GOOGLE_SANDBOX_FOLDER_ID: 'sandbox-folder' });
    const doc = await createMapDocument(model(), { config, fetchImpl });
    assert.equal(doc.url, 'https://docs.google.com/document/d/doc-123/edit');
    const assertion = decodeURIComponent(calls[0].body.split('assertion=')[1]);
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive.file');
    assert.equal(calls[1].headers.authorization, 'Bearer ya29.test');
    assert.match(calls[1].body, /"parents":\["sandbox-folder"\]/);
    assert.match(calls[1].body, /application\/vnd\.google-apps\.document/);
    await assert.rejects(getGoogleAccessToken({ serviceAccountJson: '{}', scope: 's', fetchImpl }), (e) => e.code === 'google_credentials_invalid');
  });
});

describe('HubSpot and Slack interlocks', () => {
  test('dry run intercepts deal updates; sandbox mode blocks production portals', async () => {
    const dry = recordingFetch();
    const client = createMapHubSpotClient({ token: 'test-token', dryRun: true, fetchImpl: dry.fetchImpl });
    assert.equal((await client.updateDeal('1', { map_status: 'active' })).mode, 'intercepted_dry_run');
    assert.equal(dry.calls.length, 0);
    const prod = recordingFetch((c) => (c.url.endsWith('/account-info/v3/details') ? { body: { portalId: 111, accountType: 'STANDARD' } } : {}));
    const live = createMapHubSpotClient({ token: 'test-token', dryRun: false, sandboxMode: true, fetchImpl: prod.fetchImpl });
    await assert.rejects(live.updateDeal('1', { map_status: 'active' }), (e) => e.code === 'sandbox_account_required');
    assert.ok(prod.calls.every((c) => c.method === 'GET'));
    const sb = recordingFetch((c) => (c.url.endsWith('/account-info/v3/details') ? { body: { portalId: 222, accountType: 'DEVELOPER_TEST' } } : { body: {} }));
    const sandbox = createMapHubSpotClient({ token: 'test-token', dryRun: false, sandboxMode: true, fetchImpl: sb.fetchImpl });
    assert.equal((await sandbox.updateDeal('1', { map_status: 'active' })).mode, 'written');
  });

  test('deal bundle: deal with associations, company, contacts and owner', async () => {
    const { fetchImpl, calls } = recordingFetch((c) => {
      if (c.url.includes('/crm/v3/objects/deals/77')) {
        return { body: { id: '77', properties: { dealname: 'X', hubspot_owner_id: '9' }, associations: { companies: { results: [{ id: '5' }] }, contacts: { results: [{ id: '6' }, { id: '7' }] } } } };
      }
      if (c.url.endsWith('/companies/batch/read')) return { body: { results: [{ id: '5', properties: { name: 'Acme Corp', domain: 'acme.example' } }] } };
      if (c.url.endsWith('/contacts/batch/read')) return { body: { results: [{ id: '6', properties: { firstname: 'Jane' } }, { id: '7', properties: { firstname: 'John' } }] } };
      if (c.url.includes('/crm/v3/owners/9')) return { body: { id: 9, firstName: 'Alex', lastName: 'Rivera' } };
      return { status: 404 };
    });
    const client = createMapHubSpotClient({ token: 'test-token', fetchImpl });
    const bundle = await client.getDealBundle('77', { properties: ['dealname'] });
    assert.equal(bundle.company.name, 'Acme Corp');
    assert.equal(bundle.contacts.length, 2);
    assert.equal(bundle.owner.lastName, 'Rivera');
    assert.match(calls[0].url, /associations=companies,contacts/);
  });

  test('Slack: dry run, sandbox redirect for client nudges, invalid targets refused', async () => {
    const { fetchImpl, calls } = recordingFetch(() => ({ body: { ok: true } }));
    const msg = { kind: 'client_nudge', text: 't', blocks: [] };
    assert.equal((await createMapSlackClient({ config: cfg(), fetchImpl }).send(msg)).mode, 'intercepted_dry_run');
    await assert.rejects(createMapSlackClient({ config: cfg({ DRY_RUN: 'false' }), fetchImpl }).send(msg), (e) => e.code === 'slack_sandbox_target_missing');
    const sandboxed = createMapSlackClient({ config: cfg({ DRY_RUN: 'false', SLACK_BOT_TOKEN: 'test-bot-token', SLACK_SANDBOX_CHANNEL_ID: 'C0SANDBOX1' }), fetchImpl });
    await sandboxed.send(msg, { channelOverride: 'C0CUSTOMER1' });
    assert.equal(calls[0].body.channel, 'C0SANDBOX1');
    const prod = createMapSlackClient({ config: cfg({ DRY_RUN: 'false', SANDBOX_MODE: 'false', SLACK_BOT_TOKEN: 'test-bot-token' }), fetchImpl });
    assert.equal((await prod.send(msg, { channelOverride: 'not-a-channel' })).mode, 'not_configured');
    assert.equal((await createMapSlackClient({ config: cfg({ DRY_RUN: 'false', SANDBOX_MODE: 'false', SLACK_WEBHOOK_URL: 'https://attacker.example/x' }), fetchImpl }).send(msg)).mode, 'not_configured');
  });
});

describe('MAP generation pipeline', () => {
  const run = (rawBody, env = {}, opts = {}) => {
    const config = cfg(env);
    const { fetchImpl, calls } = recordingFetch(opts.handler);
    return generateMap({ rawBody, headers: opts.headers || {} }, { config, fetchImpl, now: () => TODAY }).then((r) => ({ ...r, calls }));
  };

  test('deal ID extraction from workflow and app webhook shapes', () => {
    assert.equal(extractDealId({ objectId: 123 }), '123');
    assert.equal(extractDealId({ properties: { hs_object_id: { value: '456' } } }), '456');
    assert.equal(extractDealId([{ subscriptionType: 'contact.creation', objectId: 1 }, { subscriptionType: 'deal.propertyChange', objectId: 789 }]), '789');
    assert.equal(extractDealId({ objectId: 'abc' }), null);
  });

  test('offline dry run: plan, stub document, intercepted CRM sync and Slack, zero network calls', async () => {
    const r = await run(WEBHOOK);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.body.status, 'generated');
    assert.equal(r.body.milestones.length, 6);
    assert.equal(r.body.document.mode, 'intercepted_dry_run');
    assert.equal(r.body.crm.mode, 'intercepted_dry_run');
    assert.equal(r.body.crm.properties.map_status, 'active');
    assert.equal(r.body.crm.properties.map_contract_signature_date, '2027-01-29');
    assert.equal(r.body.crm.properties.map_kickoff_done, 'false');
    assert.equal(r.body.slack.mode, 'intercepted_dry_run');
    assert.match(r.preview, /# Mutual Action Plan: Acme Corp/);
    assert.equal(r.calls.length, 0);
  });

  test('webhook secret is enforced once configured', async () => {
    const env = { N8N_WEBHOOK_SECRET: 'test-webhook-secret-0123456789' };
    assert.equal((await run(WEBHOOK, env)).httpStatus, 401);
    assert.equal((await run(WEBHOOK, env, { headers: { 'X-Webhook-Secret': 'test-webhook-secret-0123456789' } })).httpStatus, 200);
  });

  test('ignored and failed paths', async () => {
    const wrongStage = JSON.parse(WEBHOOK);
    wrongStage.properties.dealstage.value = 'appointmentscheduled';
    assert.equal((await run(JSON.stringify(wrongStage))).body.reason, 'stage_not_targeted');
    const existing = JSON.parse(WEBHOOK);
    existing.properties.map_document_url = { value: 'https://docs.example.com/maps/x' };
    existing.properties.map_status = { value: 'active' };
    assert.equal((await run(JSON.stringify(existing))).body.reason, 'map_already_exists');
    assert.equal((await run(JSON.stringify({ ...existing, force: true }))).body.status, 'generated');
    assert.equal((await run(fixture('sample-hubspot-webhook-past-close.json'))).httpStatus, 422);
    assert.equal((await run('{bad')).httpStatus, 400);
    assert.equal((await run('{}')).body.reason, 'deal_id_missing');
    assert.equal((await run(WEBHOOK, { DRY_RUN: 'false' })).body.reason, 'config_invalid');
  });

  test('live sandbox run with a real-looking token reads, then writes only after the sandbox check', async () => {
    const handler = (c) => {
      if (c.url.includes('/crm/v3/objects/deals/1000000001')) {
        return c.method === 'GET'
          ? { body: { id: '1000000001', properties: { dealname: 'Acme Corp - Platform Rollout', closedate: '2027-01-29T17:00:00Z', dealstage: 'presentationscheduled', hubspot_owner_id: '' }, associations: {} } }
          : { body: {} };
      }
      if (c.url.endsWith('/account-info/v3/details')) return { body: { portalId: 222, accountType: 'SANDBOX' } };
      return { status: 404 };
    };
    const r = await run(WEBHOOK, { DRY_RUN: 'false', HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', N8N_WEBHOOK_SECRET: 's3cret-for-tests', ANNOUNCE_NEW_MAPS: 'false' }, { handler, headers: { 'x-webhook-secret': 's3cret-for-tests' } });
    assert.equal(r.body.status, 'generated');
    assert.equal(r.body.crm.mode, 'written');
    assert.equal(r.body.document.mode, 'stub');
    assert.ok(r.body.warnings.some((w) => w.includes('No contacts')));
    const patch = r.calls.find((c) => c.method === 'PATCH');
    assert.equal(patch.body.properties.map_document_url, 'https://docs.example.com/maps/deal-1000000001');
  });
});

describe('weekly milestone monitor', () => {
  test('evaluation: slipped, client-owned, due soon, next', () => {
    const e = evaluateMilestones({ dealProperties: ACTIVE_DEALS[0].properties, template: T, todayIso: '2026-11-16' });
    assert.deepEqual(e.slipped.map((i) => i.key), ['technical_review', 'security_audit']);
    assert.deepEqual(e.clientSlipped.map((i) => i.key), ['technical_review', 'security_audit']);
    assert.deepEqual(e.dueSoon.map((i) => i.key), ['final_proposal']);
    assert.equal(e.next.key, 'technical_review');
    assert.equal(e.slipped[0].daysLate, 4);
  });

  test('offline run: alerts slipping deals, respects cooldown, completes closed deals', async () => {
    const summary = await runOfflineMonitor({ env: { HOLIDAYS: SAMPLE_HOLIDAYS } });
    const byId = Object.fromEntries(summary.results.map((r) => [r.dealId, r]));
    assert.equal(summary.dealsChecked, 4);
    assert.equal(byId['9001'].alert.kind, 'slip_alert');
    assert.equal(byId['9001'].clientNudge.mode, 'disabled');
    assert.equal(byId['9001'].properties.map_slipped_milestones, 'Technical Review; Security Audit');
    assert.ok(byId['9001'].properties.map_last_nudge_at);
    assert.equal(byId['9002'].alert, null);
    assert.equal(byId['9003'].properties.map_status, 'completed');
    assert.deepEqual(byId['9004'].notes, ['nudge skipped: cooldown']);
    assert.equal(byId['9004'].alert, null);
  });

  test('client nudges go to the deal Slack Connect channel only when enabled (sandbox-redirected here)', async () => {
    const { fetchImpl, calls } = recordingFetch(() => ({ body: { ok: true } }));
    const config = cfg({ DRY_RUN: 'false', CLIENT_NUDGES_ENABLED: 'true', SLACK_BOT_TOKEN: 'test-bot-token', SLACK_SANDBOX_CHANNEL_ID: 'C0SANDBOX1' });
    const clients = { hubspot: { updateDeal: async () => ({ mode: 'stubbed' }) }, slack: createMapSlackClient({ config, fetchImpl }) };
    const collected = await monitorCollectStage({ config: cfg(), hubspot: offlineClients(cfg()).hubspot, now: TODAY });
    const result = await monitorActStage(collected.items[0], { config, ...clients, now: TODAY });
    assert.equal(result.clientNudge.mode, 'sent');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.body.channel === 'C0SANDBOX1'));
    assert.match(JSON.stringify(calls[1].body.blocks), /Quick check-in|check-in on the shared plan/);
  });

  test('paged HubSpot search for active MAPs', async () => {
    let page = 0;
    const { fetchImpl, calls } = recordingFetch(() => {
      page += 1;
      return { body: { results: [{ id: String(page), properties: {} }], paging: page < 3 ? { next: { after: String(page) } } : undefined } };
    });
    const config = cfg({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token' });
    const summary = await runMonitor({ config, fetchImpl, now: () => TODAY });
    assert.equal(summary.dealsChecked, 3);
    const searches = calls.filter((c) => c.url.endsWith('/deals/search'));
    assert.equal(searches.length, 3);
    assert.equal(searches[1].body.after, '1');
    assert.equal(searches[0].body.filterGroups[0].filters[0].propertyName, 'map_status');
  });
});

describe('HTTP server', () => {
  test('health, webhook and admin-guarded monitor endpoint', async () => {
    const admin = 'admin-token-for-tests-0123456789';
    const { server } = createServer({ env: { ADMIN_API_TOKEN: admin, HOLIDAYS: SAMPLE_HOLIDAYS }, now: () => TODAY, logger: () => {} });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await (await fetch(`${base}/healthz`)).json()).dryRun, true);
      const res = await fetch(`${base}/webhooks/deal-stage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: WEBHOOK });
      assert.equal((await res.json()).status, 'generated');
      assert.equal((await fetch(`${base}/monitor/run`, { method: 'POST' })).status, 401);
      const mon = await fetch(`${base}/monitor/run`, { method: 'POST', headers: { authorization: `Bearer ${admin}` } });
      assert.equal(mon.status, 200);
      assert.equal((await fetch(`${base}/webhooks/deal-stage`, { method: 'POST', body: 'x'.repeat(300000) })).status, 413);
    } finally {
      server.close();
    }
  });

  test('simulation fixtures', async () => {
    const results = await runSimulation({ env: {} });
    assert.deepEqual(results.map((r) => r.body.status), ['generated', 'generated', 'failed']);
    assert.equal(results[1].body.compressed, true);
  });
});

describe('n8n workflow parity', () => {
  const file = path.join(ROOT, 'n8n-workflow-deal-room-map.json');
  const committed = fs.readFileSync(file, 'utf8');
  const workflow = JSON.parse(committed);
  const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

  test('structure, both triggers, no credentials or secrets', () => {
    assert.equal(new Set(workflow.nodes.map((n) => n.name)).size, workflow.nodes.length);
    for (const [from, out] of Object.entries(workflow.connections)) {
      assert.ok(byName[from], from);
      for (const branch of out.main) for (const l of branch) assert.ok(byName[l.node], l.node);
    }
    assert.ok(workflow.nodes.some((n) => n.type === 'n8n-nodes-base.webhook'));
    assert.ok(workflow.nodes.some((n) => n.type === 'n8n-nodes-base.scheduleTrigger'));
    assert.ok(workflow.nodes.every((n) => !n.credentials));
    assert.ok(!/xox[abpr]-[0-9A-Za-z-]{10,}|pat-(?:na|eu)\d-[0-9a-f-]{20,}|hooks\.slack\.com\/services\/T[0-9A-Z]{6,}|secret_[A-Za-z0-9]{20,}/.test(committed));
    assert.equal(workflow.active, false);
  });

  test('committed workflow equals a fresh build from src/core/', () => {
    assert.equal(serializeWorkflow(buildWorkflow()), committed);
  });

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const requireFn = createRequire(import.meta.url);
  async function runNode(name, items, env) {
    const fn = new AsyncFunction('$input', '$env', '$getWorkflowStaticData', 'require', byName[name].parameters.jsCode);
    const helpers = { httpRequest: async () => ({ statusCode: 200, headers: {}, body: '{}' }) };
    return fn.call({ helpers }, { first: () => items[0], all: () => items }, env, () => ({}), requireFn);
  }

  test('generation branch: n8n Code nodes match the Node.js mirror', async () => {
    const env = { HOLIDAYS: SAMPLE_HOLIDAYS };
    let current = 'HubSpot Stage Webhook';
    let items = [{ json: { headers: {}, body: JSON.parse(WEBHOOK) } }];
    while (workflow.connections[current]) {
      current = workflow.connections[current].main[0][0].node;
      if (byName[current].type === 'n8n-nodes-base.code') items = await runNode(current, items, env);
    }
    assert.equal(current, 'Respond to HubSpot');
    const mirror = await generateMap({ rawBody: WEBHOOK, headers: {} }, { config: cfg(), fetchImpl: recordingFetch().fetchImpl });
    const strip = (b) => ({ ...b, crm: { ...b.crm, properties: { ...b.crm.properties, map_generated_at: null } } });
    assert.equal(items[0].json.httpStatus, mirror.httpStatus);
    assert.deepEqual(strip(items[0].json.body), strip(mirror.body));
  });

  test('monitor branch: collect node emits one item per deal and the IF routes by slipped count', async () => {
    const collected = await runNode('Find Active MAP Deals', [{ json: {} }], { HOLIDAYS: SAMPLE_HOLIDAYS });
    assert.deepEqual(collected, []);
    const ifNode = byName['Milestones Slipped?'];
    assert.equal(ifNode.parameters.conditions.conditions[0].operator.operation, 'gt');
    const mirror = await monitorCollectStage({ config: cfg(), hubspot: offlineClients(cfg()).hubspot, now: TODAY });
    const acted = await runNode('Send Slack Nudges', mirror.items.map((json) => ({ json })), { HOLIDAYS: SAMPLE_HOLIDAYS });
    assert.equal(acted.length, 4);
    assert.equal(acted.find((a) => a.json.dealId === '9003').json.properties.map_status, 'completed');
    const failed = await runNode('Refresh MAP Status', [{ json: { status: 'failed', reason: 'config_invalid' } }], {});
    assert.equal(failed[0].json.skipped, true);
  });
});
