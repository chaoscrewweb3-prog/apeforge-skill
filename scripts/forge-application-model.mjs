/**
 * Non-financial Forge draft contract. This validates syntax, not identity,
 * endpoint reachability, chain state, membership, or payment compatibility.
 * Limits: 8 services; 20 stack entries (48 chars each); 2048-char URLs;
 * 80-char names; 1200-char profile summary; 800-char service descriptions,
 * inputs and outputs. Only public-format HTTPS DNS hostnames are accepted.
 * No DNS resolution is performed: server-side connection code must perform
 * its own resolution, redirect and network-boundary checks in a later slice.
 */
export const FORGE_LIMITS = Object.freeze({ services: 8, techStack: 20, stackItem: 48, url: 2048, name: 80, summary: 1200, serviceText: 800 });

const ROOT_KEYS = ['name', 'summary', 'projectName', 'ownerWallet', 'website', 'x', 'telegram', 'techStack', 'requestedCategory', 'services'];
const SERVICE_KEYS = ['name', 'description', 'protocol', 'endpoint', 'pricing', 'unit', 'input', 'output', 'support', 'status', 'pricingDetails'];
const RESERVED_SUFFIXES = ['localhost', 'local', 'internal', 'invalid', 'test', 'example', 'onion', 'home', 'lan', 'arpa'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function validateApplication(input) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const keys = (record, allowed, prefix = '') => {
    if (!isRecord(record)) { fail(prefix || 'application', 'Expected an application object.'); return false; }
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) fail(prefix ? `${prefix}.${key}` : key, 'Unexpected field. Remove it from the draft.');
    }
    return true;
  };
  const text = (value, field, max, required = true) => {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string') { fail(field, 'Enter text, not a structured value.'); return ''; }
    const clean = value.trim();
    if (required && !clean) fail(field, 'This field is required.');
    if (clean.length > max) fail(field, `Use at most ${max} characters.`);
    if (CONTROL_CHARS.test(clean)) fail(field, 'Remove unsupported control characters.');
    return clean;
  };
  const publicUrl = (value, field, { required = true, endpoint = false, social = '' } = {}) => {
    const clean = text(value, field, FORGE_LIMITS.url, required);
    if (!clean) return '';
    let url;
    try { url = new URL(clean); } catch { fail(field, 'Enter a complete public HTTPS URL.'); return ''; }
    const authority = /^https:\/\/([^/?#]*)/i.exec(clean)?.[1] || '';
    if (url.protocol !== 'https:' || url.username || url.password || authority.includes('@') || /\s|\\/.test(clean)) {
      fail(field, 'Use HTTPS without credentials, spaces or backslashes.'); return '';
    }
    const host = url.hostname.toLowerCase();
    const labels = host.split('.');
    const publicHost = labels.length >= 2 && host.length <= 253
      && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      && /^[a-z]{2,63}$/.test(labels.at(-1))
      && !RESERVED_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))
      && !RESERVED_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
    if (!publicHost) { fail(field, 'Use a public DNS hostname; local, reserved and IP-literal addresses are not accepted.'); return ''; }
    if (endpoint && clean.includes('#')) fail(field, 'Service endpoints must not include a fragment (#).');
    if (social === 'x' && (!['x.com', 'twitter.com'].includes(host) || !/^\/[a-zA-Z0-9_]{1,15}\/?$/.test(url.pathname) || url.search || url.hash || url.port)) {
      fail(field, 'Use an X profile such as https://x.com/your_handle.');
    }
    if (social === 'telegram' && (host !== 't.me' || !/^\/[a-zA-Z][a-zA-Z0-9_]{4,31}\/?$/.test(url.pathname) || url.search || url.hash || url.port)) {
      fail(field, 'Use a public Telegram profile such as https://t.me/your_handle.');
    }
    return url.href;
  };

  if (!keys(input, ROOT_KEYS)) return { ok: false, errors, application: null };
  const name = text(input.name, 'name', FORGE_LIMITS.name);
  const summary = text(input.summary, 'summary', FORGE_LIMITS.summary);
  const projectName = text(input.projectName, 'projectName', FORGE_LIMITS.name, false);
  const ownerWallet = text(input.ownerWallet, 'ownerWallet', 42);
  if (!/^0x[0-9a-fA-F]{40}$/.test(ownerWallet)) fail('ownerWallet', 'Enter a Base/EVM public wallet address: 0x followed by 40 hexadecimal characters.');
  const website = publicUrl(input.website, 'website', { required: false });
  const x = publicUrl(input.x, 'x', { required: false, social: 'x' });
  const telegram = publicUrl(input.telegram, 'telegram', { required: false, social: 'telegram' });
  if (!website && !x && !telegram) fail('website', 'Provide at least one public website, X profile or Telegram profile.');
  const requestedCategory = input.requestedCategory;
  if (!['community', 'partner'].includes(requestedCategory)) fail('requestedCategory', 'Choose Community or Partner. Core membership cannot be requested here.');

  const techStack = [];
  if (!Array.isArray(input.techStack) || input.techStack.length < 1 || input.techStack.length > FORGE_LIMITS.techStack) {
    fail('techStack', `List 1–${FORGE_LIMITS.techStack} technologies.`);
  } else {
    const seen = new Set();
    input.techStack.forEach((item, index) => {
      const clean = text(item, `techStack.${index}`, FORGE_LIMITS.stackItem);
      if (clean && !seen.has(clean.toLowerCase())) { techStack.push(clean); seen.add(clean.toLowerCase()); }
    });
  }

  const services = [];
  if (!Array.isArray(input.services) || input.services.length > FORGE_LIMITS.services) {
    fail('services', `List 0–${FORGE_LIMITS.services} services.`);
  } else {
    input.services.forEach((service, index) => {
      const prefix = `services.${index}`;
      if (!keys(service, SERVICE_KEYS, prefix)) return;
      const field = key => `${prefix}.${key}`;
      const serviceName = text(service.name, field('name'), FORGE_LIMITS.name);
      const description = text(service.description, field('description'), FORGE_LIMITS.serviceText);
      const protocol = service.protocol;
      if (!['mcp', 'rest', 'a2a'].includes(protocol)) fail(field('protocol'), 'Choose MCP, REST API or A2A.');
      const status = service.status;
      if (status !== undefined && !['planned', 'active'].includes(status)) fail(field('status'), 'Choose planned or active.');
      const endpoint = publicUrl(service.endpoint, field('endpoint'), { endpoint: true, required: status !== 'planned' });
      if (status === 'planned' && endpoint) fail(field('endpoint'), 'Planned services must omit the endpoint or use an empty string. Publish an endpoint only when active.');
      const pricing = service.pricing;
      if (!['free', 'ape-quote', 'external', 'x402-usdc-base'].includes(pricing)) fail(field('pricing'), 'Choose free, ape-quote, external or x402-usdc-base.');
      const pricingDetails = text(service.pricingDetails, field('pricingDetails'), 800, ['external', 'x402-usdc-base'].includes(pricing));
      const unit = text(service.unit, field('unit'), 100);
      const serviceInput = text(service.input, field('input'), FORGE_LIMITS.serviceText);
      const output = text(service.output, field('output'), FORGE_LIMITS.serviceText);
      const support = publicUrl(service.support, field('support'));
      services.push({ name: serviceName, description, protocol, endpoint, pricing, unit, input: serviceInput, output, support, ...(status !== undefined ? { status } : {}), ...(service.pricingDetails !== undefined ? { pricingDetails } : {}) });
    });
  }

  if (errors.length) return { ok: false, errors, application: null };
  return {
    ok: true, errors: [],
    application: {
      schemaVersion: 1,
      kind: 'forge-application-draft',
      submissionState: 'local-draft',
      requestedCategory,
      profile: { name, summary, projectName, ownerWallet: ownerWallet.toLowerCase(), website, x, telegram, techStack, services },
      verification: { wallet: 'unverified', membership: 'not-submitted', lock: 'not-checked' }
    }
  };
}

export function serializeApplication(input) {
  const result = validateApplication(input);
  if (!result.ok) {
    const error = new TypeError('The Forge application draft is invalid.');
    error.errors = result.errors;
    throw error;
  }
  return JSON.stringify(result.application, null, 2);
}
