/**
 * Mutual Action Plan document: a provider-neutral model plus renderers for
 * Markdown (stub / preview), HTML (Google Docs import) and Notion blocks, and
 * the document providers themselves (stub, Google Docs via a service account,
 * Notion API). Every provider honours DRY_RUN and SANDBOX_MODE.
 */
import crypto from 'node:crypto';
import { isPlaceholderSetting } from './config.js';

export class DocumentSafetyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DocumentSafetyError';
    this.code = code;
  }
}

function formatHumanDate(iso) {
  if (!iso) return 'TBC';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatAmount(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${n.toLocaleString('en-US')} ${currency || ''}`.trim();
  }
}

export function buildMapModel({ deal, company, owner, plan, stakeholders, config, generatedAt }) {
  const doc = config.document;
  const p = deal.properties || {};
  const companyName = (company && company.name) || p.dealname || 'Customer';
  const ownerName = owner ? [owner.firstName, owner.lastName].filter(Boolean).join(' ') || 'Account Executive' : 'Account Executive';
  const person = (role) => {
    const s = stakeholders.byRole[role];
    if (!s) return 'To be confirmed';
    const base = s.jobTitle ? `${s.name} (${s.jobTitle})` : s.name;
    return doc.includeContactEmails && s.email ? `${base} <${s.email}>` : base;
  };
  const internalPerson = (role) => (role === 'ae' ? ownerName : doc.internalRoleLabels[role] || role);
  return {
    title: `Mutual Action Plan: ${companyName} × ${doc.sellerCompanyName}`,
    dealId: String(deal.id),
    dealName: p.dealname || `Deal ${deal.id}`,
    companyName,
    sellerCompanyName: doc.sellerCompanyName,
    amount: doc.includeAmount ? formatAmount(p.amount, p.deal_currency_code) : null,
    closeDate: plan.closeDate,
    generatedAt,
    compressed: plan.compressed,
    shortRunway: plan.shortRunway,
    stakeholders: stakeholders.people.map((s) => ({
      name: s.name,
      jobTitle: s.jobTitle,
      email: doc.includeContactEmails ? s.email : null,
      roles: Object.entries(stakeholders.byRole)
        .filter(([, v]) => v && v.id === s.id)
        .map(([role]) => role),
    })),
    internalTeam: [{ name: ownerName, role: 'Account Executive' }],
    milestones: plan.milestones.map((m) => ({
      ...m,
      targetDateLabel: formatHumanDate(m.targetDate),
      clientOwner: m.owner === 'internal' ? '—' : person(m.clientRole),
      internalOwner: m.owner === 'client' ? `${internalPerson(m.internalRole)} (support)` : internalPerson(m.internalRole),
      ownerLabel: m.owner === 'both' ? 'Joint' : m.owner === 'client' ? companyName : doc.sellerCompanyName,
    })),
  };
}

export function renderMapMarkdown(model) {
  const lines = [
    `# ${model.title}`,
    '',
    `**Deal:** ${model.dealName}  `,
    `**Target close:** ${formatHumanDate(model.closeDate)}  `,
    model.amount ? `**Investment:** ${model.amount}  ` : null,
    `**Plan generated:** ${model.generatedAt.slice(0, 10)}`,
    '',
    model.compressed
      ? '> ⚠️ The timeline is shorter than the standard plan, so milestones were spread evenly up to the close date. Review the dates together at kickoff.'
      : null,
    '',
    '## Purpose',
    '',
    `This plan lists the steps both teams agree to complete for ${model.companyName} to reach a decision by the target close date. Each milestone has one owner on each side. Dates move only by mutual agreement.`,
    '',
    '## Milestones',
    '',
    '| # | Milestone | Target date | Lead | Customer owner | Supplier owner | Status |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...model.milestones.map((m, i) => `| ${i + 1} | ${m.name} | ${m.targetDateLabel} | ${m.ownerLabel} | ${m.clientOwner} | ${m.internalOwner} | ☐ Open |`),
    '',
    ...model.milestones.flatMap((m) => [`### ${m.name}: ${m.targetDateLabel}`, '', m.description, '']),
    '## Stakeholders',
    '',
    `**${model.companyName}**`,
    '',
    ...(model.stakeholders.length
      ? model.stakeholders.map((s) => `- ${s.name}${s.jobTitle ? `, ${s.jobTitle}` : ''}${s.roles.length ? ` (${s.roles.map((r) => r.replace('_', ' ')).join(', ')})` : ''}${s.email ? ` · ${s.email}` : ''}`)
      : ['- To be confirmed at kickoff']),
    '',
    `**${model.sellerCompanyName}**`,
    '',
    ...model.internalTeam.map((t) => `- ${t.name}, ${t.role}`),
    '',
    '## How this plan is maintained',
    '',
    '- Completed milestones are ticked off in the CRM, and both teams review this plan weekly.',
    '- If a date is at risk, the owner flags it as early as possible so both teams can agree a new date.',
    '',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

function escapeMapHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderMapHtml(model) {
  const rows = model.milestones
    .map((m, i) => `<tr><td>${i + 1}</td><td><b>${escapeMapHtml(m.name)}</b><br>${escapeMapHtml(m.description)}</td><td>${escapeMapHtml(m.targetDateLabel)}</td><td>${escapeMapHtml(m.ownerLabel)}</td><td>${escapeMapHtml(m.clientOwner)}</td><td>${escapeMapHtml(m.internalOwner)}</td><td>☐ Open</td></tr>`)
    .join('');
  const people = model.stakeholders.length
    ? model.stakeholders.map((s) => `<li>${escapeMapHtml(s.name)}${s.jobTitle ? `, ${escapeMapHtml(s.jobTitle)}` : ''}${s.roles.length ? ` (${escapeMapHtml(s.roles.join(', ').replace(/_/g, ' '))})` : ''}${s.email ? ` · ${escapeMapHtml(s.email)}` : ''}</li>`).join('')
    : '<li>To be confirmed at kickoff</li>';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeMapHtml(model.title)}</title></head><body>
<h1>${escapeMapHtml(model.title)}</h1>
<p><b>Deal:</b> ${escapeMapHtml(model.dealName)}<br><b>Target close:</b> ${escapeMapHtml(formatHumanDate(model.closeDate))}${model.amount ? `<br><b>Investment:</b> ${escapeMapHtml(model.amount)}` : ''}<br><b>Plan generated:</b> ${escapeMapHtml(model.generatedAt.slice(0, 10))}</p>
${model.compressed ? '<p><i>The timeline is shorter than the standard plan, so milestones were spread evenly up to the close date. Review the dates together at kickoff.</i></p>' : ''}
<h2>Purpose</h2><p>This plan lists the steps both teams agree to complete for ${escapeMapHtml(model.companyName)} to reach a decision by the target close date. Each milestone has one owner on each side. Dates move only by mutual agreement.</p>
<h2>Milestones</h2>
<table border="1" cellpadding="6" cellspacing="0"><thead><tr><th>#</th><th>Milestone</th><th>Target date</th><th>Lead</th><th>Customer owner</th><th>Supplier owner</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Stakeholders</h2><p><b>${escapeMapHtml(model.companyName)}</b></p><ul>${people}</ul>
<p><b>${escapeMapHtml(model.sellerCompanyName)}</b></p><ul>${model.internalTeam.map((t) => `<li>${escapeMapHtml(t.name)}, ${escapeMapHtml(t.role)}</li>`).join('')}</ul>
<h2>How this plan is maintained</h2><ul><li>Completed milestones are ticked off in the CRM, and both teams review this plan weekly.</li><li>If a date is at risk, the owner flags it as early as possible so both teams can agree a new date.</li></ul>
</body></html>`;
}

const notionText = (content) => [{ type: 'text', text: { content: String(content).slice(0, 1900) } }];

export function renderMapNotionBlocks(model) {
  const blocks = [
    { object: 'block', type: 'paragraph', paragraph: { rich_text: notionText(`Deal: ${model.dealName} · Target close: ${formatHumanDate(model.closeDate)}${model.amount ? ` · Investment: ${model.amount}` : ''}`) } },
  ];
  if (model.compressed) {
    blocks.push({ object: 'block', type: 'callout', callout: { icon: { type: 'emoji', emoji: '⚠️' }, rich_text: notionText('Short timeline: milestones were spread evenly up to the close date. Review the dates together at kickoff.') } });
  }
  blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: notionText('Milestones') } });
  for (const m of model.milestones) {
    blocks.push({
      object: 'block',
      type: 'to_do',
      to_do: { checked: false, rich_text: notionText(`${m.name}: ${m.targetDateLabel} · Lead: ${m.ownerLabel} · Customer: ${m.clientOwner} · Supplier: ${m.internalOwner}`) },
    });
  }
  blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: notionText('Stakeholders') } });
  for (const s of model.stakeholders.length ? model.stakeholders : [{ name: 'To be confirmed at kickoff', jobTitle: '', roles: [] }]) {
    blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: notionText(`${s.name}${s.jobTitle ? `, ${s.jobTitle}` : ''}${s.roles.length ? ` (${s.roles.join(', ').replace(/_/g, ' ')})` : ''}`) } });
  }
  for (const t of model.internalTeam) {
    blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: notionText(`${t.name}, ${t.role} (${model.sellerCompanyName})`) } });
  }
  return blocks.slice(0, 100);
}

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** OAuth 2.0 JWT-bearer flow for a Google service account (no SDK). */
export async function getGoogleAccessToken({ serviceAccountJson, scope, fetchImpl, nowMs = Date.now() }) {
  let key;
  try {
    key = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  } catch {
    throw new DocumentSafetyError('google_credentials_invalid', 'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!key || !key.client_email || !key.private_key) throw new DocumentSafetyError('google_credentials_invalid', 'Service account JSON needs client_email and private_key');
  const iat = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({ iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  const assertion = `${header}.${claims}.${base64Url(signature)}`;
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  });
  if (!response.ok) throw new DocumentSafetyError('google_auth_failed', `Google token endpoint returned HTTP ${response.status}`);
  return JSON.parse(await response.text()).access_token;
}

/** Creates the MAP with the configured provider. Returns { provider, mode, url, documentId }. */
export async function createMapDocument(model, { config, fetchImpl }) {
  const doc = config.document;
  const dryRunUrl = `${doc.stubBaseUrl.replace(/\/+$/, '')}/deal-${encodeURIComponent(model.dealId)}${config.dryRun ? '?dry_run=true' : ''}`;
  if (doc.provider === 'stub') {
    return { provider: 'stub', mode: config.dryRun ? 'intercepted_dry_run' : 'stub', url: dryRunUrl, documentId: null, markdown: renderMapMarkdown(model) };
  }
  if (config.dryRun) {
    return { provider: doc.provider, mode: 'intercepted_dry_run', url: dryRunUrl, documentId: null, markdown: renderMapMarkdown(model) };
  }
  if (doc.provider === 'google_docs') {
    const folderId = config.sandboxMode ? doc.google.sandboxFolderId : doc.google.folderId;
    if (isPlaceholderSetting(folderId)) throw new DocumentSafetyError('google_folder_missing', 'No Google Drive folder configured for this mode');
    const token = await getGoogleAccessToken({ serviceAccountJson: doc.google.serviceAccountJson, scope: doc.google.scope, fetchImpl });
    const boundary = `map_${crypto.randomBytes(8).toString('hex')}`;
    const metadata = { name: model.title, mimeType: 'application/vnd.google-apps.document', parents: [folderId] };
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      renderMapHtml(model),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const response = await fetchImpl('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!response.ok) throw new DocumentSafetyError('google_create_failed', `Google Drive returned HTTP ${response.status}`);
    const created = JSON.parse(await response.text());
    return {
      provider: 'google_docs',
      mode: 'created',
      environment: config.sandboxMode ? 'sandbox' : 'production',
      documentId: created.id,
      url: created.webViewLink || `https://docs.google.com/document/d/${created.id}/edit`,
    };
  }
  if (doc.provider === 'notion') {
    const databaseId = config.sandboxMode ? doc.notion.sandboxDatabaseId : doc.notion.databaseId;
    if (isPlaceholderSetting(databaseId)) throw new DocumentSafetyError('notion_database_missing', 'No Notion database configured for this mode');
    const response = await fetchImpl('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { authorization: `Bearer ${doc.notion.token}`, 'notion-version': doc.notion.version, 'content-type': 'application/json' },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties: { [doc.notion.titleProperty]: { title: notionText(model.title) } },
        children: renderMapNotionBlocks(model),
      }),
    });
    if (!response.ok) throw new DocumentSafetyError('notion_create_failed', `Notion returned HTTP ${response.status}`);
    const created = JSON.parse(await response.text());
    return { provider: 'notion', mode: 'created', environment: config.sandboxMode ? 'sandbox' : 'production', documentId: created.id, url: created.url };
  }
  throw new DocumentSafetyError('provider_invalid', `Unsupported DOC_PROVIDER "${doc.provider}"`);
}
