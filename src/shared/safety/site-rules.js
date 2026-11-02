// @ts-check
// Built-in site lists for page sensitivity tiers (architecture §14.2). A host matches a listed
// domain when it IS that domain or a subdomain of it: the match is anchored at a dot, never a
// substring, so "hdfcbank.com.example.net" and "nothdfcbank.com" don't match "hdfcbank.com"
// (EC-TIR-01, EC-TIR-02). Imported by the service worker and the panel only.

/** Tier 3: banking, payments, UPI and checkout. Pagewise never reads or acts here. */
export const FINANCIAL_DOMAINS = Object.freeze([
  // Indian public-sector banks
  'onlinesbi.sbi', 'sbi.co.in', 'onlinesbi.com', 'bankofbaroda.in', 'bobibanking.com', 'pnbindia.in', 'netpnb.com',
  'canarabank.com', 'unionbankofindia.co.in', 'bankofindia.co.in', 'indianbank.in', 'centralbankofindia.co.in',
  'iob.in', 'ucobank.com', 'bankofmaharashtra.in', 'psbindia.com',
  // Indian private-sector and small-finance banks
  'hdfcbank.com', 'icicibank.com', 'axisbank.com', 'kotak.com', 'kotakbank.com', 'yesbank.in', 'indusind.com',
  'idfcfirstbank.com', 'bandhanbank.com', 'federalbank.co.in', 'rblbank.com', 'southindianbank.com',
  'karurvysyabank.co.in', 'tmb.in', 'cityunionbank.com', 'dcbbank.com', 'jkbank.com', 'kvb.co.in',
  'aubank.in', 'equitasbank.com', 'ujjivansfb.in', 'airtelbank.com', 'idbibank.in', 'csb.co.in',
  // Global banks
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'hsbc.com', 'hsbc.co.in',
  'barclays.co.uk', 'barclays.com', 'lloydsbank.com', 'natwest.com', 'santander.co.uk', 'standardchartered.com',
  'sc.com', 'dbs.com', 'db.com', 'capitalone.com', 'usbank.com', 'americanexpress.com', 'discover.com',
  // Payment gateways and checkout
  'razorpay.com', 'rzp.io', 'payu.in', 'payumoney.com', 'billdesk.com', 'ccavenue.com', 'cashfree.com',
  'instamojo.com', 'paypal.com', 'paypal.me', 'checkout.stripe.com', 'buy.stripe.com', 'adyen.com',
  'checkout.com', 'squareup.com', 'pay.amazon.com', 'pay.amazon.in',
  // UPI apps and wallets
  'paytm.com', 'paytm.in', 'phonepe.com', 'pay.google.com', 'bhimupi.org.in', 'npci.org.in', 'mobikwik.com',
  'freecharge.in', 'cred.club', 'amazonpay.in',
  // Card networks' cardholder portals and 3-D Secure
  'visa.com', 'mastercard.com', 'rupay.co.in', 'securecode.mastercard.com'
]);

/** Hosts whose first label says "banking": netbanking.x.com, ibank.x.in, upi.x.com (§14.2 rule 2). */
const FINANCIAL_HOST_RE = /(^|\.)(netbanking|ibank|onlinesbi|upi|retail-banking|corporatebanking)\./;

/** Tier 2: private personal content. Reading is off; selected text only, after an acknowledgment. */
export const SENSITIVE_DOMAINS = Object.freeze([
  // Webmail
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com',
  'mail.proton.me', 'mail.zoho.com', 'mail.zoho.in', 'rediffmail.com',
  // Personal documents and storage
  'docs.google.com', 'drive.google.com', 'onedrive.live.com', 'dropbox.com', 'photos.google.com', 'icloud.com',
  // Messaging
  'web.whatsapp.com', 'web.telegram.org', 'messenger.com', 'teams.microsoft.com', 'teams.live.com', 'app.slack.com',
  'discord.com',
  // Health portals
  'practo.com', 'apollo247.com', 'abdm.gov.in', 'healthid.ndhm.gov.in', 'mychart.com', 'cowin.gov.in',
  // Government ID and tax portals
  'uidai.gov.in', 'incometax.gov.in', 'digilocker.gov.in', 'passportindia.gov.in', 'epfindia.gov.in',
  'gst.gov.in', 'parivahan.gov.in', 'irs.gov', 'ssa.gov', 'login.gov'
]);

/**
 * Suffixes no one can own (EC-TIR-12). Not the whole public-suffix list: the common ones people
 * might type by mistake, plus hosting platforms where only a subdomain belongs to someone.
 */
const PUBLIC_SUFFIXES = new Set([
  'com', 'net', 'org', 'in', 'io', 'dev', 'app', 'edu', 'gov', 'co', 'uk', 'us', 'info', 'xyz', 'me', 'ai',
  'co.in', 'org.in', 'net.in', 'ac.in', 'edu.in', 'gov.in', 'nic.in', 'res.in', 'co.uk', 'org.uk', 'ac.uk', 'com.au',
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev', 'web.app', 'firebaseapp.com', 'herokuapp.com',
  'blogspot.com', 'wordpress.com', 'glitch.me', 'onrender.com'
]);

/**
 * The host of a URL, lower-cased with any trailing dot removed (EC-TIR-03, EC-TIR-04). `new URL`
 * already turns an internationalised name into punycode. '' if it isn't a URL.
 * @param {string} url
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

/**
 * Is `host` this domain or one of its subdomains? Anchored, never a substring.
 * @param {string} host already normalised by hostOf
 * @param {string} domain
 */
export function hostMatches(host, domain) {
  const d = String(domain).toLowerCase().trim().replace(/\.$/, '');
  return Boolean(d) && (host === d || host.endsWith(`.${d}`));
}

/** @param {string} host */
export function isFinancialHost(host) {
  return FINANCIAL_HOST_RE.test(host) || FINANCIAL_DOMAINS.some((d) => hostMatches(host, d));
}

/** @param {string} host */
export function isSensitiveHost(host) {
  return SENSITIVE_DOMAINS.some((d) => hostMatches(host, d));
}

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Check a domain typed into Settings → Safety (pure). A pasted URL is reduced to its host. It must
 * be a full hostname: two or more labels, no wildcard, and not a bare public suffix (EC-TIR-12).
 * @param {unknown} raw
 * @returns {{ ok: true, domain: string } | { ok: false, error: string }}
 */
export function normalizeDomainInput(raw) {
  let text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!text) return { ok: false, error: 'Type a site, like example.com.' };
  if (text.includes('*')) return { ok: false, error: 'Wildcards aren’t supported. Type the site itself, like example.com: its subdomains are included.' };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = hostOf(text);
  else text = hostOf(`https://${text.split(/[/?#]/)[0]}`);
  if (text.startsWith('www.')) text = text.slice(4);
  const labels = text.split('.');
  if (!text || labels.length < 2 || !labels.every((l) => LABEL_RE.test(l)) || /^\d+$/.test(labels.at(-1) ?? '')) {
    return { ok: false, error: 'That isn’t a full site name. Type something like example.com.' };
  }
  if (PUBLIC_SUFFIXES.has(text)) return { ok: false, error: `“${text}” is shared by many sites. Type your own site, like yourname.${text}.` };
  return { ok: true, domain: text };
}
