#!/usr/bin/env node
/**
 * Node.js runtime for the MAP generator (mirror of the n8n workflow).
 *
 *   node src/index.js                 HTTP server: POST /webhooks/deal-stage, POST /monitor/run, GET /healthz
 *   node src/index.js --simulate      run the webhook fixtures offline (DRY_RUN forced on)
 *   node src/index.js --monitor       run the weekly milestone monitor once (cron-friendly)
 *   node src/index.js --preview       print the generated MAP Markdown for the main fixture
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPlaceholderSetting, loadMapConfig, validateMapConfig } from './core/config.js';
import { createMapClients, generateMap, runMonitor } from './core/pipeline.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'fixtures', name), 'utf8'));

export function loadDotEnvFile(filePath = path.join(ROOT_DIR, '.env'), target = process.env) {
  if (!fs.existsSync(filePath)) return false;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (target[match[1]] === undefined) target[match[1]] = value;
  }
  return true;
}

function log(level, msg, data = {}) {
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data })}\n`);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    req.on('end', () => (size > maxBytes ? reject(Object.assign(new Error('payload_too_large'), { statusCode: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json), 'cache-control': 'no-store' });
  res.end(json);
}

export function createServer({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), logger = log } = {}) {
  const config = loadMapConfig(env);
  const clients = createMapClients(config, { fetchImpl });
  const adminToken = env.ADMIN_API_TOKEN;
  const adminEnabled = !isPlaceholderSetting(adminToken) && String(adminToken).length >= 24;
  const webhookPath = env.WEBHOOK_PATH || '/webhooks/deal-stage';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const { errors, warnings } = validateMapConfig(config);
        return sendJson(res, 200, { ok: !errors.length, dryRun: config.dryRun, sandboxMode: config.sandboxMode, docProvider: config.document.provider, errors: errors.length, warnings: warnings.length });
      }
      if (req.method === 'POST' && url.pathname === webhookPath) {
        const rawBody = await readBody(req, config.webhook.maxBodyBytes);
        const result = await generateMap({ rawBody, headers: req.headers }, { config, fetchImpl, clients, now });
        logger(result.body.status === 'failed' ? 'warn' : 'info', 'map_webhook', { status: result.body.status, reason: result.body.reason, dealId: result.body.dealId, document: result.body.document?.mode || null, crm: result.body.crm?.mode || null });
        return sendJson(res, result.httpStatus, result.body);
      }
      if (req.method === 'POST' && url.pathname === '/monitor/run') {
        if (!adminEnabled) return sendJson(res, 404, { error: 'not_found' });
        const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
        const expected = Buffer.from(String(adminToken));
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return sendJson(res, 401, { error: 'unauthorized' });
        const summary = await runMonitor({ config, fetchImpl, clients, now });
        logger('info', 'monitor_run', { dealsChecked: summary.dealsChecked, dealsSlipping: summary.dealsSlipping });
        return sendJson(res, 200, summary);
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      const status = err.statusCode || 500;
      logger('error', 'request_failed', { status, message: err.message });
      return sendJson(res, status, { status: 'failed', reason: status === 413 ? 'payload_too_large' : 'internal_error' });
    }
  });
  return { server, config, adminEnabled, webhookPath };
}

export const SAMPLE_HOLIDAYS = '2026-11-26,2026-12-24,2026-12-25,2026-12-31,2027-01-01';

export function simulationNow(env = process.env) {
  return Date.parse(`${env.SIMULATE_TODAY || '2026-11-16'}T09:00:00Z`);
}

export async function runSimulation({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = loadMapConfig({ ...env, DRY_RUN: 'true', HUBSPOT_PRIVATE_APP_TOKEN: '', HOLIDAYS: env.HOLIDAYS ?? SAMPLE_HOLIDAYS });
  const now = () => simulationNow(env);
  const files = ['sample-hubspot-webhook.json', 'sample-hubspot-webhook-short-runway.json', 'sample-hubspot-webhook-past-close.json'];
  const results = [];
  for (const file of files) {
    const rawBody = fs.readFileSync(path.join(ROOT_DIR, 'fixtures', file), 'utf8');
    const headers = { [config.webhook.secretHeader]: config.webhook.secret };
    results.push({ file, ...(await generateMap({ rawBody, headers }, { config, fetchImpl, now })) });
  }
  return results;
}

export async function runOfflineMonitor({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = loadMapConfig(env);
  const offline = isPlaceholderSetting(config.hubspot.token);
  const clients = createMapClients(config, { fetchImpl, offlineDeals: offline ? readFixture('sample-active-deals.json') : [] });
  return runMonitor({ config, fetchImpl, clients, now: offline ? () => simulationNow(env) : () => Date.now() });
}

async function main(argv) {
  loadDotEnvFile();
  if (argv.includes('--simulate')) {
    for (const r of await runSimulation()) {
      const b = r.body;
      process.stdout.write(`\n▶ ${r.file}  [HTTP ${r.httpStatus}] status=${b.status}${b.reason ? ` reason=${b.reason}` : ''}${b.compressed ? ' (compressed timeline)' : ''}\n`);
      for (const m of b.milestones || []) process.stdout.write(`   ${m.targetDate}  ${m.name.padEnd(32)} ${m.owner}\n`);
      if (b.document) process.stdout.write(`   document: ${b.document.provider}/${b.document.mode} ${b.document.url}\n   hubspot: ${b.crm?.mode}   slack: ${b.slack?.mode}\n`);
      for (const w of b.warnings) process.stdout.write(`   ! ${w}\n`);
    }
    process.stdout.write('\nSimulation ran offline with DRY_RUN forced to true (today = SIMULATE_TODAY, default 2026-11-16).\n');
    return;
  }
  if (argv.includes('--preview')) {
    const [first] = await runSimulation();
    process.stdout.write(`${first.preview}\n`);
    return;
  }
  if (argv.includes('--monitor')) {
    const summary = await runOfflineMonitor();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = summary.status === 'failed' ? 1 : 0;
    return;
  }
  const { server, config, adminEnabled, webhookPath } = createServer();
  const { errors, warnings } = validateMapConfig(config);
  warnings.forEach((w) => log('warn', 'config_warning', { warning: w }));
  if (errors.length) {
    errors.forEach((e) => log('error', 'config_error', { error: e }));
    process.exitCode = 1;
    return;
  }
  const port = Number(process.env.PORT) || 3000;
  server.requestTimeout = 60000;
  server.listen(port, () => log('info', 'server_started', { port, webhookPath, dryRun: config.dryRun, sandboxMode: config.sandboxMode, docProvider: config.document.provider, monitorEndpoint: adminEnabled }));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
