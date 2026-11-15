# ⚠️ Disclaimer & Liability Limitation

DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer. This automation pipeline is provided strictly on an as-is basis without warranties of any kind. I assume no liability for API rate limits, data synchronization errors, CRM state discrepancies, or third-party service outages.

---

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-hubspot-deal-room-mutual-action-plan-generator`) are for educational and architectural demonstration purposes. I publish them as a reference implementation from dhRobin Systems, not as a managed product or service.

## No Liability

The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, special, exemplary, or consequential damages resulting from the use, misuse, or deployment of these scripts. That includes, without limitation: incorrect or missed milestone dates; Mutual Action Plans shared with the wrong people or containing the wrong information; deal properties overwritten or left out of sync; Slack messages sent to the wrong channel, sent late, or not sent at all; lost revenue; damaged customer relationships; regulatory penalties; and business interruption. This applies however the damage is caused and on any theory of liability, even if advised of the possibility of such damage.

## No Warranty

All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement. I do not warrant compatibility with any specific version of n8n, Node.js, HubSpot, Google Drive/Docs, Notion, or Slack, or that their APIs will keep the shapes and behaviour this project expects.

## Production Testing Required

Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox, a dedicated Google Drive folder or Notion database, and a Slack test channel) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Review every generated plan before it is shared with a customer. Treat every property update and every message to a customer-facing channel as irreversible.

## Customer-Facing Content

A Mutual Action Plan is a document your customer reads, and client nudges post into channels your customer can see. You are responsible for the accuracy, tone, and confidentiality of everything this pipeline generates and sends. That includes the names, titles, and contact details of the customer's employees, deal amounts, and dates. Commercial terms are not commitments until both parties have agreed them in writing.

## Third-Party APIs & Compliance

Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR, UK GDPR, CCPA/CPRA, and any other applicable law), and security policies of HubSpot, Google, Notion, Slack, and any other connected service. That includes:

- confirming a lawful basis for processing customer contacts' names, job titles, and email addresses in documents and messages;
- controlling who can open each generated document (Drive folder permissions, Notion workspace access) and who is in each Slack channel;
- respecting HubSpot, Google, Notion, and Slack API rate limits and quotas, including for large weekly monitoring runs;
- honouring data subject requests and retention policies across HubSpot, document stores, Slack, and n8n execution data;
- reviewing every automated property update and nudge, especially before enabling `CLIENT_NUDGES_ENABLED`.

## Security

Webhook secrets, sandbox interlocks, and dry-run defaults reduce risk but do not eliminate it. You are responsible for protecting tokens and service-account keys, rotating credentials, restricting access to n8n and the monitoring endpoint, and keeping all dependencies patched.

## Not Professional Advice

Nothing in this repository is legal, compliance, privacy, or sales-methodology advice. Consult qualified professionals for your jurisdiction and use case.

---

Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
