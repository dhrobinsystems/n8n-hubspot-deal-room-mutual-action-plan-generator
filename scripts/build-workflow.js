#!/usr/bin/env node
/**
 * Generates n8n-workflow-deal-room-map.json from src/core/.
 *
 * Each Code node embeds the same core modules src/index.js imports (imports and
 * `export` keywords stripped) plus a few lines that run one stage. The tests
 * rebuild the workflow, fail if the committed JSON drifts, and execute the Code
 * nodes to compare them with the Node.js mirror.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_PATH = path.join(ROOT, 'n8n-workflow-deal-room-map.json');
export const CORE_MODULES = ['src/core/config.js', 'src/core/milestones.js', 'src/core/mapDocument.js', 'src/core/hubspot.js', 'src/core/slack.js', 'src/core/pipeline.js'];
const PRELUDE_NAMES = ['crypto', 'env', 'config', 'n8nHelpers', 'n8nFetch', 'n8nSleep', 'clients', 'ctx', 'item', 'items', 'results', 'collected'];
const TOP_LEVEL_DECL = /^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

function stripModuleSyntax(source, file) {
  const out = source
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\s)/gm, '');
  if (/^(?:import|export)\s/m.test(out)) throw new Error(`${file}: unsupported import/export syntax`);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function buildLibrarySource(root = ROOT) {
  const seen = new Map(PRELUDE_NAMES.map((n) => [n, 'n8n prelude']));
  return CORE_MODULES.map((rel) => {
    const body = stripModuleSyntax(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
    for (const m of body.matchAll(TOP_LEVEL_DECL)) {
      if (seen.has(m[1])) throw new Error(`Top-level name "${m[1]}" in ${rel} collides with ${seen.get(m[1])}`);
      seen.set(m[1], rel);
    }
    return `// ---- ${rel} ----\n${body}`;
  }).join('\n\n');
}

const PRELUDE = `
const env = $env;
const config = loadMapConfig(env);
const n8nHelpers = this.helpers;
const n8nSleep = (ms) => new Promise((resolve) => (typeof setTimeout === 'function' ? setTimeout(resolve, ms) : resolve()));
const n8nFetch = async (url, init = {}) => {
  const response = await n8nHelpers.httpRequest({
    url,
    method: init.method || 'GET',
    headers: init.headers || {},
    body: init.body,
    json: false,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
    timeout: 30000,
  });
  const raw = response.body;
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : raw == null ? '' : JSON.stringify(raw);
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    headers: { get: (name) => (response.headers || {})[String(name).toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};
const clients = createMapClients(config, { fetchImpl: n8nFetch, sleep: n8nSleep });
`;

const STAGES = {
  'Validate & Extract Deal ID': `const item = $input.first();
const ctx = await ingestMapStage({ body: item.json.body, headers: item.json.headers || {} }, { config, now: Date.now() });
return [{ json: ctx }];`,
  'Fetch Deal from HubSpot': 'const ctx = await loadDealStage($input.first().json, { config, hubspot: clients.hubspot });\nreturn [{ json: ctx }];',
  'Calculate Milestone Dates': 'const ctx = await planStage($input.first().json, { config, now: Date.now() });\nreturn [{ json: ctx }];',
  'Generate MAP Document': 'const ctx = await documentStage($input.first().json, { config, fetchImpl: n8nFetch });\nreturn [{ json: ctx }];',
  'Update HubSpot Deal': 'const ctx = await crmSyncStage($input.first().json, { hubspot: clients.hubspot });\nreturn [{ json: ctx }];',
  'Announce MAP in Slack': 'const ctx = await notifyMapStage($input.first().json, { config, slack: clients.slack });\nreturn [{ json: ctx }];',
  'Build Webhook Response': 'const ctx = finalizeMapStage($input.first().json);\nreturn [{ json: ctx }];',
  'Find Active MAP Deals': `const collected = await monitorCollectStage({ config, hubspot: clients.hubspot, now: Date.now() });
if (collected.status !== 'collected') return [{ json: { status: collected.status, reason: collected.reason, errors: collected.errors || [] } }];
return collected.items.map((entry) => ({ json: entry }));`,
  'Send Slack Nudges': `const items = $input.all();
const results = [];
for (const entry of items) results.push({ json: await monitorActStage(entry.json, { config, hubspot: clients.hubspot, slack: clients.slack, now: Date.now() }) });
return results;`,
  'Refresh MAP Status': `const items = $input.all();
const results = [];
for (const entry of items) results.push({ json: await monitorActStage(entry.json, { config, hubspot: clients.hubspot, slack: clients.slack, now: Date.now() }) });
return results;`,
};

const id = (n) => `d3a1b2c4-0000-4f00-9a00-${String(n).padStart(12, '0')}`;

const NOTE = `## Deal Room: Mutual Action Plan Generator

Generated from src/core/ by scripts/build-workflow.js. Edit src/core/, then run \`npm run build:workflow\` and re-import.

**Safe by default:** DRY_RUN and SANDBOX_MODE stay true unless set to false. DOC_PROVIDER=stub creates no documents. Client nudges are off (CLIENT_NUDGES_ENABLED=false).

**n8n host settings:** \`NODE_FUNCTION_ALLOW_BUILTIN=crypto\`, \`N8N_BLOCK_ENV_ACCESS_IN_NODE=false\`, plus the variables from .env.example.

Top row: HubSpot stage-change webhook → MAP. Bottom row: weekly milestone monitor → Slack nudges.`;

export function buildWorkflow(root = ROOT) {
  const library = buildLibrarySource(root);
  const header = "// AUTO-GENERATED by scripts/build-workflow.js from src/core/. Edit src/core/, then run `npm run build:workflow`.\nconst crypto = require('crypto');";
  const code = (name, n, position) => ({
    parameters: { jsCode: `${header}\n\n${library}\n\n// ---- n8n stage runner ----${PRELUDE}\n${STAGES[name]}\n` },
    id: id(n),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  });
  const nodes = [
    { parameters: { content: NOTE, height: 360, width: 560 }, id: id(1), name: 'Read Me', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-80, -460] },
    {
      parameters: { httpMethod: 'POST', path: 'deal-room-map', responseMode: 'responseNode', options: {} },
      id: id(2),
      name: 'HubSpot Stage Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      webhookId: id(99),
    },
    code('Validate & Extract Deal ID', 3, [220, 0]),
    code('Fetch Deal from HubSpot', 4, [440, 0]),
    code('Calculate Milestone Dates', 5, [660, 0]),
    code('Generate MAP Document', 6, [880, 0]),
    code('Update HubSpot Deal', 7, [1100, 0]),
    code('Announce MAP in Slack', 8, [1320, 0]),
    code('Build Webhook Response', 9, [1540, 0]),
    {
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.body) }}', options: { responseCode: '={{ $json.httpStatus }}' } },
      id: id(10),
      name: 'Respond to HubSpot',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [1760, 0],
    },
    {
      parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * 1' }] } },
      id: id(11),
      name: 'Weekly Milestone Check',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 320],
    },
    code('Find Active MAP Deals', 12, [220, 320]),
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
          conditions: [
            {
              id: id(14),
              leftValue: '={{ $json.evaluation ? $json.evaluation.slipped.length : 0 }}',
              rightValue: 0,
              operator: { type: 'number', operation: 'gt' },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: id(13),
      name: 'Milestones Slipped?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      position: [440, 320],
    },
    code('Send Slack Nudges', 15, [680, 220]),
    code('Refresh MAP Status', 16, [680, 420]),
  ];
  const link = (node) => ({ node, type: 'main', index: 0 });
  const chain = ['HubSpot Stage Webhook', 'Validate & Extract Deal ID', 'Fetch Deal from HubSpot', 'Calculate Milestone Dates', 'Generate MAP Document', 'Update HubSpot Deal', 'Announce MAP in Slack', 'Build Webhook Response', 'Respond to HubSpot'];
  const connections = {};
  for (let i = 0; i < chain.length - 1; i += 1) connections[chain[i]] = { main: [[link(chain[i + 1])]] };
  connections['Weekly Milestone Check'] = { main: [[link('Find Active MAP Deals')]] };
  connections['Find Active MAP Deals'] = { main: [[link('Milestones Slipped?')]] };
  connections['Milestones Slipped?'] = { main: [[link('Send Slack Nudges')], [link('Refresh MAP Status')]] };
  return {
    name: 'HubSpot Deal Room: Mutual Action Plan Generator',
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveManualExecutions: false },
    pinData: {},
    meta: { templateCredsSetupCompleted: true },
    tags: [],
  };
}

export function serializeWorkflow(workflow) {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const json = serializeWorkflow(buildWorkflow());
  fs.writeFileSync(OUTPUT_PATH, json);
  process.stdout.write(`Wrote ${path.relative(ROOT, OUTPUT_PATH)} (${(json.length / 1024).toFixed(1)} KiB)\n`);
}
