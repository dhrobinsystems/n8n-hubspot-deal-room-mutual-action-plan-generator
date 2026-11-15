/**
 * Slack messages (MAP created, internal slip alert, client nudge) and a sender
 * with the same interlocks as the CRM client:
 *   DRY_RUN=true      -> message returned, never sent
 *   SANDBOX_MODE=true -> every message (including client nudges) goes to the
 *                        sandbox channel / webhook only
 * Client nudges go to a Slack Connect channel ID stored on the deal, and only
 * when CLIENT_NUDGES_ENABLED=true.
 */
import { isPlaceholderSetting } from './config.js';

export class SlackSafetyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'SlackSafetyError';
    this.code = code;
  }
}

export function slackEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function modeTag(config) {
  if (config.dryRun) return '[DRY RUN] ';
  if (config.sandboxMode) return '[SANDBOX] ';
  return '';
}

function link(url, label) {
  return url && /^https:\/\//.test(url) ? `<${url}|${slackEscape(label)}>` : slackEscape(label);
}

function ownerMention(config, ownerId) {
  const slackId = ownerId ? config.slack.ownerSlackMap[String(ownerId)] : null;
  return slackId && /^[UW][A-Z0-9]{5,}$/.test(slackId) ? `<@${slackId}>` : null;
}

export function buildMapCreatedMessage({ model, documentUrl, dealUrl, ownerId, config }) {
  const lines = model.milestones.map((m) => `• *${slackEscape(m.name)}*: ${slackEscape(m.targetDateLabel)} (${slackEscape(m.ownerLabel)})`).join('\n');
  const mention = ownerMention(config, ownerId);
  return {
    kind: 'map_created',
    text: `${modeTag(config)}Mutual Action Plan ready for ${model.dealName}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${modeTag(config)}MAP ready: ${model.dealName}`.slice(0, 150) } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${mention ? `${mention} ` : ''}${link(documentUrl, 'Open the Mutual Action Plan')} · ${link(dealUrl, 'HubSpot deal')}\nTarget close: *${slackEscape(model.closeDate)}*${model.compressed ? '\n:warning: Short runway: milestones were compressed. Confirm the dates at kickoff.' : ''}`,
        },
      },
      { type: 'section', text: { type: 'mrkdwn', text: lines.slice(0, 2900) } },
    ],
  };
}

export function buildSlipAlertMessage({ deal, evaluation, dealUrl, config }) {
  const p = deal.properties;
  const mention = ownerMention(config, p.hubspot_owner_id);
  const fmt = (i) => `• *${slackEscape(i.name)}* (${i.owner === 'internal' ? 'internal' : i.owner === 'both' ? 'joint' : 'client'}): due ${slackEscape(i.targetDate)}, ${i.daysLate} business day${i.daysLate === 1 ? '' : 's'} late`;
  const soon = evaluation.dueSoon.map((i) => `• ${slackEscape(i.name)}: due ${slackEscape(i.targetDate)}`).join('\n');
  return {
    kind: 'slip_alert',
    text: `${modeTag(config)}${evaluation.slipped.length} MAP milestone(s) slipped on ${p.dealname || `deal ${deal.id}`}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${modeTag(config)}MAP slipping: ${p.dealname || `Deal ${deal.id}`}`.slice(0, 150) } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${mention ? `${mention} ` : ''}${evaluation.slipped.map(fmt).join('\n')}`.slice(0, 2900),
        },
      },
      ...(soon ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Due soon*\n${soon}`.slice(0, 2900) } }] : []),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${link(p.map_document_url, 'MAP')} · ${link(dealUrl, 'HubSpot deal')} · close date ${slackEscape(String(p.closedate || '').slice(0, 10) || 'n/a')}` }],
      },
    ],
  };
}

export function buildClientNudgeMessage({ deal, evaluation, config }) {
  const p = deal.properties;
  const items = evaluation.clientSlipped.map((i) => `• *${slackEscape(i.name)}* (planned for ${slackEscape(i.targetDate)})`).join('\n');
  return {
    kind: 'client_nudge',
    text: `${modeTag(config)}Quick check-in on the shared plan`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${modeTag(config)}Hi all, a quick check-in on the shared plan. These steps were planned for earlier dates and still show as open:\n${items}\n\nIf any of them is done, or the date needs to move, reply here and I'll update the plan. ${link(p.map_document_url, 'Open the plan')}`.slice(0, 2900),
        },
      },
    ],
  };
}

function validWebhook(url) {
  return !isPlaceholderSetting(url) && String(url).startsWith('https://hooks.slack.com/');
}

function validChannel(id) {
  return !isPlaceholderSetting(id) && /^[CGD][A-Z0-9]{6,}$/.test(String(id));
}

export function createMapSlackClient({ config, fetchImpl = globalThis.fetch }) {
  const s = config.slack;
  const hasBot = !isPlaceholderSetting(s.botToken);

  function resolveTarget(channelOverride) {
    if (config.sandboxMode) {
      if (hasBot && validChannel(s.sandboxChannelId)) return { type: 'api', channel: s.sandboxChannelId, environment: 'sandbox' };
      if (validWebhook(s.sandboxWebhookUrl)) return { type: 'webhook', url: s.sandboxWebhookUrl, environment: 'sandbox' };
      throw new SlackSafetyError('slack_sandbox_target_missing', 'SANDBOX_MODE=true requires SLACK_SANDBOX_CHANNEL_ID (with SLACK_BOT_TOKEN) or SLACK_SANDBOX_WEBHOOK_URL');
    }
    if (channelOverride) {
      if (hasBot && validChannel(channelOverride)) return { type: 'api', channel: channelOverride, environment: 'production' };
      return null;
    }
    if (hasBot && validChannel(s.channelId)) return { type: 'api', channel: s.channelId, environment: 'production' };
    if (validWebhook(s.webhookUrl)) return { type: 'webhook', url: s.webhookUrl, environment: 'production' };
    return null;
  }

  async function send(message, { channelOverride = null } = {}) {
    if (config.dryRun) return { mode: 'intercepted_dry_run', kind: message.kind, environment: config.sandboxMode ? 'sandbox' : 'production' };
    const target = resolveTarget(channelOverride);
    if (!target) return { mode: 'not_configured', kind: message.kind };
    const payload = { text: message.text, blocks: message.blocks };
    if (target.type === 'webhook') {
      const response = await fetchImpl(target.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`Slack webhook returned HTTP ${response.status}`);
      return { mode: 'sent', kind: message.kind, environment: target.environment, via: 'webhook' };
    }
    const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${s.botToken}` },
      body: JSON.stringify({ channel: target.channel, ...payload, unfurl_links: false }),
    });
    const body = JSON.parse((await response.text()) || '{}');
    if (!response.ok || body.ok !== true) throw new Error(`Slack chat.postMessage failed: ${body.error || response.status}`);
    return { mode: 'sent', kind: message.kind, environment: target.environment, via: 'chat.postMessage' };
  }

  return { send, resolveTarget };
}
