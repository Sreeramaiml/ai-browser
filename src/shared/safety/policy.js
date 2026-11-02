// @ts-check
// Safety facade for the service worker (architecture §14.1): page sensitivity tiers (checkPage),
// the agent allow-list, and the per-action check. Content scripts re-check fields and clicks with
// the classic copies of the same rules at execute time, so one bug can't bypass every layer.

import { PRACTICE_SITE_URL } from '../config.js';
import { classifyAction } from './action-rules.js';
import { classifyField, looksLikeSecretValue } from './field-rules.js';
import { hostMatches, hostOf, isFinancialHost, isSensitiveHost } from './site-rules.js';

// ---- Page tiers (architecture §14.2) ----

/**
 * What the content script found on the page (CS_PAGE_SIGNALS). Keywords only count in labels,
 * inputs and the headings of pages with fields, never in body text (EC-TIR-16).
 * @typedef {{
 *   hasPasswordField: boolean, hasCardFields: boolean, hasOtpField: boolean, hasUpiField: boolean,
 *   keywords: string[], frameHosts: string[]
 * }} PageSignals
 * @typedef {0|2|3} Tier
 * @typedef {'blocked'|'financial'|'financial-frame'|'payment-fields'|'unchecked'|'sensitive'|'login'} TierReason
 * @typedef {{ read: Tier, act: Tier, reason: TierReason|null }} PageTiers read: reading features;
 *   act: the agent and screenshots. Highest match wins in each.
 * @typedef {'read'|'selection'|'screenshot'|'agent'} PageFeature read: summary, chat, YouTube on the
 *   page, Find, answer skills; selection: right-click actions on selected text
 * @typedef {{ allowed: true, scope: 'page'|'selection-only' }
 *   | { allowed: false, code: 'PAGE_BLOCKED'|'NEEDS_ACK', tier: Tier, reason: TierReason|null, message: string, domain?: string }} PageVerdict
 */

/** Strongest first: when two rules give the same tier, the earlier one explains it. */
const REASON_ORDER = /** @type {const} */ (['blocked', 'financial', 'financial-frame', 'payment-fields', 'unchecked', 'sensitive', 'login']);

/**
 * How sensitive is this page? (pure) `signals` null means the page couldn't be checked, which
 * counts as sensitive for reading and off-limits for acting (fail closed, EC-TIR-19).
 * @param {{ url: string, signals: PageSignals|null, userBlockedDomains?: string[] }} page
 * @returns {PageTiers}
 */
export function pageTiers({ url, signals, userBlockedDomains = [] }) {
  const host = hostOf(url);
  /** @type {Array<{ read: Tier, act: Tier, reason: TierReason }>} */
  const hits = [];
  if (host && userBlockedDomains.some((d) => hostMatches(host, d))) hits.push({ read: 3, act: 3, reason: 'blocked' }); // EC-TIR-17
  if (host && isFinancialHost(host)) hits.push({ read: 3, act: 3, reason: 'financial' });
  if (signals === null) {
    hits.push({ read: 2, act: 3, reason: 'unchecked' });
  } else {
    // A payment iframe makes the page tier 3 while it's there (EC-TIR-06).
    if ((signals.frameHosts ?? []).some((h) => isFinancialHost(hostOf(`https://${h}`)))) hits.push({ read: 3, act: 3, reason: 'financial-frame' });
    if (signals.hasCardFields || signals.hasOtpField || signals.hasUpiField || (signals.keywords ?? []).length) {
      hits.push({ read: 2, act: 3, reason: 'payment-fields' });
    }
    if (signals.hasPasswordField) hits.push({ read: 2, act: 0, reason: 'login' }); // the login form itself is blocked per action
  }
  if (host && isSensitiveHost(host)) hits.push({ read: 2, act: 2, reason: 'sensitive' });

  if (!hits.length) return { read: 0, act: 0, reason: null };
  const read = /** @type {Tier} */ (Math.max(...hits.map((h) => h.read)));
  const act = /** @type {Tier} */ (Math.max(...hits.map((h) => h.act)));
  const top = Math.max(read, act);
  const reason = REASON_ORDER.find((r) => hits.some((h) => h.reason === r && Math.max(h.read, h.act) === top)) ?? null;
  return { read, act, reason };
}

const SELECT_INSTEAD = 'You can still select text and use the right-click actions.';

/**
 * Friendly copy for a blocked feature (§14.2): what happened and why, never a bare "blocked".
 * @param {TierReason|null} reason
 * @param {PageFeature} feature
 */
function blockedMessage(reason, feature) {
  const verb = feature === 'screenshot' ? 'capture' : 'read';
  switch (reason) {
    case 'blocked':
      return "You've switched Pagewise off on this site. You can change that in Settings → Safety.";
    case 'financial':
    case 'financial-frame':
      return 'Pagewise is switched off on payment and banking pages to keep your money safe.';
    case 'payment-fields':
      return feature === 'read'
        ? `This page asks for card, UPI or OTP details, so Pagewise won't read it. ${SELECT_INSTEAD}`
        : 'This page asks for card, UPI or OTP details, so Pagewise is switched off here to keep your money safe.';
    case 'unchecked':
      return "Pagewise couldn't check whether this page is safe, so it won't use it. Reload the page and try again.";
    case 'sensitive':
      return feature === 'agent'
        ? "The agent doesn't run on private pages like email, documents or messages."
        : `This page holds private content like email, documents or messages, so Pagewise won't ${verb} it.${feature === 'read' ? ` ${SELECT_INSTEAD}` : ''}`;
    case 'login':
      return `This page has a login form, so Pagewise won't ${verb} it.${feature === 'read' ? ` ${SELECT_INSTEAD}` : ''}`;
    default:
      return "Pagewise can't be used on this page.";
  }
}

/**
 * May this feature use this page? (pure, architecture §14.2)
 * - read: tier 0 only
 * - selection: tier 0, or tier 2 once the user has acknowledged the domain; then only the
 *   selected text is sent (EC-TIR-09)
 * - screenshot: tier 0 for both reading and acting
 * - agent: acting tier 0 (the allow-list is checked separately)
 * - tier 3: never, with no override
 * @param {PageTiers} tiers
 * @param {PageFeature} feature
 * @param {{ url: string, sensitiveAckDomains?: string[] }} ctx
 * @returns {PageVerdict}
 */
export function checkPage(tiers, feature, { url, sensitiveAckDomains = [] }) {
  const tier = /** @type {Tier} */ (feature === 'agent' ? tiers.act : feature === 'screenshot' ? Math.max(tiers.read, tiers.act) : tiers.read);
  if (tier === 0) return { allowed: true, scope: 'page' };
  if (feature === 'selection' && tier === 2) {
    const host = hostOf(url);
    if (host && sensitiveAckDomains.some((d) => hostMatches(host, d))) return { allowed: true, scope: 'selection-only' };
    return {
      allowed: false, code: 'NEEDS_ACK', tier, reason: tiers.reason, domain: host,
      message: `${host || 'This page'} is a private page. Only the text you selected will be sent to the AI (Google, or Groq as a backup), nothing else from the page.`
    };
  }
  return { allowed: false, code: 'PAGE_BLOCKED', tier, reason: tiers.reason, message: blockedMessage(tiers.reason, feature) };
}

/**
 * The context header's badge (🟢 / 🟡 / 🔴).
 * @param {PageTiers} tiers
 * @returns {{ level: 'ok'|'sensitive'|'blocked', label: string }}
 */
export function safetyBadge(tiers) {
  if (tiers.read === 3 || tiers.act === 3) {
    return { level: 'blocked', label: tiers.reason === 'unchecked' ? blockedMessage('unchecked', 'agent') : blockedMessage(tiers.reason, 'agent') };
  }
  if (tiers.read === 2 || tiers.act === 2) return { level: 'sensitive', label: blockedMessage(tiers.reason, 'read') };
  return { level: 'ok', label: 'Pagewise can read this page.' };
}

/**
 * @typedef {import('./field-rules.js').FieldInfo & import('./action-rules.js').ActionInfo & {
 *   protected?: import('./field-rules.js').ProtectedKind|null
 * }} TargetInfo the scanner's view of the target element; `protected` is what it found at scan time
 * @typedef {{ allowed: boolean, reason: string|null, requiresConfirm: boolean }} ActionVerdict
 */

/** Hosts that only exist on the user's own machine: where `npx serve practice` runs (EC-PRC-01). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const NOT_ALLOWED = "The agent only works on Pagewise's practice site and on sites you've added as your own in Settings.";

/**
 * May the agent act on this page? Checked before AGENT_START and after every navigation (§14.3).
 * @param {string} url
 * @param {{ ownedDomains?: string[], practiceSiteUrl?: string }} [opts]
 * @returns {{ allowed: true, reason: null, via: 'practice'|'owned' } | { allowed: false, reason: string }}
 */
export function checkAgentAllowed(url, { ownedDomains = [], practiceSiteUrl = PRACTICE_SITE_URL } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { allowed: false, reason: 'Open a web page first.' };
  }
  if (u.protocol === 'file:') {
    // EC-PRC-02
    return {
      allowed: false,
      reason: 'The agent doesn’t run on local files. Serve the practice site with `npx serve practice` and open http://localhost:3000.'
    };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { allowed: false, reason: NOT_ALLOWED };

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (LOCAL_HOSTS.has(host)) return { allowed: true, reason: null, via: 'practice' }; // any port
  if (practiceSiteUrl && `${u.origin}${u.pathname}`.startsWith(practiceSiteUrl)) return { allowed: true, reason: null, via: 'practice' };

  for (const raw of ownedDomains) {
    const domain = String(raw).toLowerCase().trim().replace(/\.$/, '');
    // The domain itself or any subdomain, never a look-alike suffix ("notexample.com").
    if (domain && (host === domain || host.endsWith(`.${domain}`))) return { allowed: true, reason: null, via: 'owned' };
  }
  return { allowed: false, reason: NOT_ALLOWED };
}

const KIND_LABEL = { password: 'password', otp: 'OTP or PIN', card: 'card or UPI' };
const SECRET_LABEL = { card: 'a card number', aadhaar: 'an Aadhaar number', otp: 'a one-time code', cvv: 'a card security code' };

/** @param {string} reason @returns {ActionVerdict} */
const deny = (reason) => ({ allowed: false, reason, requiresConfirm: false });
/** @type {ActionVerdict} */
const OK = { allowed: true, reason: null, requiresConfirm: false };

/**
 * May this proposed step run, and does it need a second confirmation? Run after the model proposes
 * it and again when the user approves (§14.1).
 * @param {{ type: string, value?: string }} action
 * @param {TargetInfo|null} target null for steps without a target (scroll, done)
 * @param {{ pageOtp?: boolean, pageCard?: boolean, fromProfile?: boolean }} [ctx]
 * @returns {ActionVerdict}
 */
export function checkAction(action, target, ctx = {}) {
  switch (action?.type) {
    case 'scroll':
    case 'wait':
    case 'note':
    case 'done':
      return OK;

    case 'type':
    case 'select': {
      if (!target) return deny('That step needs something on the page to act on.');
      // Fail closed: protected if either the scan or a fresh look says so.
      const kind = target.protected || classifyField({ ...target, type: target.type ?? target.inputType, pageOtp: ctx.pageOtp });
      if (kind) return deny(`Pagewise never types into ${KIND_LABEL[kind]} fields.`);
      if (action.type === 'type') {
        const secret = looksLikeSecretValue(String(action.value ?? ''), {
          label: target.label, pageOtp: ctx.pageOtp, pageCard: ctx.pageCard, fromProfile: ctx.fromProfile
        });
        if (secret) return deny(`That value looks like ${SECRET_LABEL[secret]}, so Pagewise won't type it.`);
      }
      return OK;
    }

    case 'click': {
      if (!target) return deny('That step needs something on the page to act on.');
      const { kind, reason } = classifyAction(target);
      if (kind === 'blocked') return deny(`Pagewise won't click this. ${reason}`);
      if (kind === 'consequential') return { allowed: true, reason, requiresConfirm: true };
      return OK;
    }

    default:
      return deny('Pagewise doesn’t know that kind of step.');
  }
}
