/**
 * HubSpot CRM v3/v4 client for the MAP generator.
 *
 * Reads: deal + associated company/contacts + owner, and a paged search for
 * deals with an active MAP. Writes: deal property PATCH only.
 * Safety interlock on every write:
 *   DRY_RUN=true      -> recorded and returned, never sent
 *   SANDBOX_MODE=true -> the token's portal must report a SANDBOX / DEVELOPER_TEST
 *                        account type, or equal HUBSPOT_SANDBOX_PORTAL_ID
 * A placeholder token puts the client offline: reads return synthetic data built
 * from the trigger payload (or injected offline deals), writes are refused.
 */
import { isPlaceholderSetting } from './config.js';

export class HubSpotSafetyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'HubSpotSafetyError';
    this.code = code;
  }
}

export class HubSpotRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HubSpotRequestError';
    this.status = status;
    this.code = `http_${status}`;
  }
}

export const MAP_SUMMARY_PROPERTIES = [
  'map_document_url',
  'map_status',
  'map_generated_at',
  'map_next_milestone',
  'map_next_milestone_date',
  'map_slipped_milestones',
  'map_last_nudge_at',
  'map_slack_connect_channel_id',
];
export const DEAL_CORE_PROPERTIES = ['dealname', 'amount', 'closedate', 'dealstage', 'pipeline', 'hubspot_owner_id', 'hs_is_closed', 'deal_currency_code'];
export const CONTACT_PROPERTIES = ['firstname', 'lastname', 'jobtitle', 'email', 'hs_buying_role'];

export function milestonePropertyNames(template) {
  return template.flatMap((m) => [`map_${m.key}_date`, `map_${m.key}_done`]);
}

export function dealPropertiesToRead(template) {
  return [...DEAL_CORE_PROPERTIES, ...MAP_SUMMARY_PROPERTIES, ...milestonePropertyNames(template)];
}

export function hubspotDealUrl(appBaseUrl, portalId, dealId) {
  if (isPlaceholderSetting(portalId) || !/^\d+$/.test(String(portalId)) || !/^\d+$/.test(String(dealId))) return null;
  return `${String(appBaseUrl).replace(/\/+$/, '')}/contacts/${portalId}/record/0-3/${dealId}`;
}

/** Synthetic bundle for offline simulation: values come from the webhook payload when present. */
export function offlineDealBundle(dealId, payload = {}) {
  const props = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const value = (k) => (props[k] && typeof props[k] === 'object' && 'value' in props[k] ? props[k].value : props[k]);
  const offline = payload.offline || {};
  return {
    deal: {
      id: String(dealId),
      properties: {
        dealname: value('dealname') || 'Offline Simulation Deal',
        amount: value('amount') || null,
        closedate: value('closedate') || null,
        dealstage: value('dealstage') || null,
        pipeline: value('pipeline') || 'default',
        hubspot_owner_id: value('hubspot_owner_id') || null,
        hs_is_closed: 'false',
        deal_currency_code: value('deal_currency_code') || 'USD',
        map_document_url: value('map_document_url') || null,
        map_status: value('map_status') || null,
      },
    },
    company: offline.company || { id: 'offline-company', name: 'Example Customer Inc.' },
    contacts: Array.isArray(offline.contacts) ? offline.contacts : [],
    owner: offline.owner || { id: 'offline-owner', firstName: 'Alex', lastName: 'Rivera' },
  };
}

export function createMapHubSpotClient({
  token,
  dryRun = true,
  sandboxMode = true,
  sandboxPortalId = '',
  baseUrl = 'https://api.hubapi.com',
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  offlineDeals = [],
}) {
  const offline = isPlaceholderSetting(token);
  const apiBase = String(baseUrl).replace(/\/+$/, '');
  const audit = [];
  let sandboxCheck = null;

  async function call(method, path, body, { allow404 = false } = {}) {
    if (offline) throw new HubSpotSafetyError('hubspot_offline', 'HubSpot token is a placeholder; live API calls are disabled');
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 404 && allow404) return null;
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt, 10000));
        continue;
      }
      if (!response.ok) throw new HubSpotRequestError(`HubSpot ${method} ${path.split('?')[0]} failed with HTTP ${response.status}`, response.status);
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }
  }

  async function verifySandbox() {
    if (!sandboxCheck) {
      sandboxCheck = (async () => {
        const details = await call('GET', '/account-info/v3/details');
        const portalId = String(details && details.portalId !== undefined ? details.portalId : '');
        const accountType = String((details && details.accountType) || '').toUpperCase();
        if (!isPlaceholderSetting(sandboxPortalId)) {
          if (portalId !== String(sandboxPortalId)) {
            throw new HubSpotSafetyError('sandbox_portal_mismatch', 'SANDBOX_MODE=true but the token belongs to a portal other than HUBSPOT_SANDBOX_PORTAL_ID');
          }
        } else if (!['SANDBOX', 'DEVELOPER_TEST'].includes(accountType)) {
          throw new HubSpotSafetyError('sandbox_account_required', `SANDBOX_MODE=true but the account type is "${accountType || 'unknown'}"`);
        }
        return { portalId, accountType };
      })();
    }
    return sandboxCheck;
  }

  async function getDealBundle(dealId, { properties, payload } = {}) {
    if (offline) return offlineDealBundle(dealId, payload);
    const deal = await call(
      'GET',
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(properties.join(','))}&associations=companies,contacts`,
      undefined,
      { allow404: true },
    );
    if (!deal) return null;
    const assoc = (type) => ((deal.associations && deal.associations[type] && deal.associations[type].results) || []).map((r) => String(r.id));
    const [companyIds, contactIds] = [assoc('companies'), assoc('contacts')];
    let company = null;
    if (companyIds.length) {
      const companies = await call('POST', '/crm/v3/objects/companies/batch/read', { properties: ['name', 'domain'], inputs: [{ id: companyIds[0] }] });
      const c = companies && companies.results && companies.results[0];
      company = c ? { id: c.id, name: c.properties.name, domain: c.properties.domain } : null;
    }
    let contacts = [];
    if (contactIds.length) {
      const result = await call('POST', '/crm/v3/objects/contacts/batch/read', { properties: CONTACT_PROPERTIES, inputs: contactIds.slice(0, 50).map((id) => ({ id })) });
      contacts = ((result && result.results) || []).map((c) => ({ id: c.id, ...c.properties }));
    }
    let owner = null;
    const ownerId = deal.properties && deal.properties.hubspot_owner_id;
    if (ownerId) {
      const o = await call('GET', `/crm/v3/owners/${encodeURIComponent(ownerId)}`, undefined, { allow404: true });
      owner = o ? { id: String(o.id), firstName: o.firstName || '', lastName: o.lastName || '' } : null;
    }
    return { deal: { id: String(deal.id), properties: deal.properties || {} }, company, contacts, owner };
  }

  async function searchActiveMapDeals({ properties, maxDeals = 500 }) {
    if (offline) return offlineDeals.slice(0, maxDeals);
    const deals = [];
    let after;
    do {
      const body = {
        filterGroups: [{ filters: [{ propertyName: 'map_status', operator: 'EQ', value: 'active' }] }],
        properties,
        limit: 100,
        sorts: [{ propertyName: 'closedate', direction: 'ASCENDING' }],
      };
      if (after) body.after = after;
      const page = await call('POST', '/crm/v3/objects/deals/search', body);
      for (const d of (page && page.results) || []) deals.push({ id: String(d.id), properties: d.properties || {} });
      after = page && page.paging && page.paging.next ? page.paging.next.after : undefined;
    } while (after && deals.length < maxDeals);
    return deals.slice(0, maxDeals);
  }

  async function updateDeal(dealId, properties) {
    if (!properties || !Object.keys(properties).length) return { mode: 'skipped' };
    if (dryRun) {
      const record = { mode: 'intercepted_dry_run', method: 'PATCH', path: `/crm/v3/objects/deals/${dealId}`, properties };
      audit.push(record);
      return record;
    }
    if (sandboxMode) await verifySandbox();
    await call('PATCH', `/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { properties });
    audit.push({ mode: 'written', method: 'PATCH', path: `/crm/v3/objects/deals/${dealId}` });
    return { mode: 'written', environment: sandboxMode ? 'sandbox' : 'production' };
  }

  return { offline, getDealBundle, searchActiveMapDeals, updateDeal, verifySandbox, auditLog: () => audit.slice() };
}
