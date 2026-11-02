#!/usr/bin/env node
/** ApeForge public application-review intake. No package dependencies. */
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateApplication } from './forge-application-model.mjs';

export const REPO = 'chaoscrewweb3-prog/apeforge-skill';
export const REPO_URL = `https://github.com/${REPO}`;
export const PROTOCOL_VERSION = '2025-11-25';
const MAX_BODY = 32768;
const MAX_LINE = 65536;
const execFile = promisify(execFileCallback);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const byteLength = value => Buffer.byteLength(value, 'utf8');
const problem = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
const ownKeys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const issueUrl = value => typeof value === 'string' && new RegExp(`^https://github\\.com/${REPO}/issues/[1-9][0-9]{0,9}$`).test(value);
const requestIdValid = value => typeof value === 'string' && /^forge-v1-[a-f0-9]{64}$/.test(value);
const markerFor = id => `<!-- ${id} -->`;

export function prepare(application) {
  if (!record(application)) return problem('invalid_application', 'Supply a raw application object.');
  let encoded;
  try { encoded = JSON.stringify(application); } catch { return problem('invalid_application', 'Application must be plain JSON.'); }
  if (byteLength(encoded) > MAX_BODY) return problem('body_too_large', 'Application exceeds 32768 UTF-8 bytes.');
  const checked = validateApplication(application);
  if (!checked.ok) return problem('invalid_application', 'Correct the listed fields; no data was sent.', {
    errors: checked.errors.slice(0, 40).map(error => ({
      field: /^(?:application|name|summary|projectName|ownerWallet|website|x|telegram|requestedCategory|techStack(?:\.[0-9]{1,2})?|services(?:\.[0-9](?:\.(?:name|description|protocol|endpoint|pricing|unit|input|output|support))?)?)$/.test(error.field) ? error.field : 'application',
      message: error.message
    }))
  });
  const normalized = checked.application;
  const raw = { ...normalized.profile, requestedCategory: normalized.requestedCategory };
  // normalize field order before hashing: semantically equal key order gets one marker.
  const canonical = JSON.stringify(raw, null, 2);
  const requestId = `forge-v1-${createHash('sha256').update(canonical).digest('hex')}`;
  const body = [
    '# Forge application review request', '', markerFor(requestId), '',
    'Public profile supplied by the applicant. Unverified: not a registered listing, membership or payment.', '',
    '```json', canonical, '```', '',
    'The applicant consented to publishing this profile in this public repository.'
  ].join('\n');
  if (byteLength(body) > MAX_BODY) return problem('body_too_large', 'Prepared issue exceeds 32768 UTF-8 bytes.');
  return { ok: true, requestId, application: raw, issueTitle: `Forge application: ${raw.name}`, issueBody: body,
    reviewState: 'prepared-not-submitted', publicDestination: REPO_URL, registrationState: 'not-registered' };
}

async function defaultGh(args) {
  // Inherit the applicant's existing gh auth; never extract a token or invoke a shell.
  const result = await execFile('gh', args, {
    timeout: 12000, maxBuffer: 262144, windowsHide: true,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' }
  });
  return result.stdout;
}

export function createService({ runGh = defaultGh } = {}) {
  const attempted = new Set();
  const inFlight = new Set();
  async function ghJson(args) {
    const raw = await runGh(args);
    if (typeof raw !== 'string' || byteLength(raw) > 262144) throw new Error('invalid_response');
    return JSON.parse(raw);
  }
  async function readiness() {
    try {
      const user = await ghJson(['api', '--hostname', 'github.com', 'user', '--jq', '{login:.login}']);
      const repo = await ghJson(['api', '--hostname', 'github.com', `repos/${REPO}`, '--jq', '{full_name:.full_name,private:.private,has_issues:.has_issues,archived:.archived}']);
      if (!record(user) || typeof user.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(user.login)
        || !record(repo) || repo.full_name !== REPO || repo.private !== false || repo.has_issues !== true || repo.archived !== false) {
        return problem('intake_unavailable', 'The fixed public intake repository or authenticated GitHub identity is unavailable.');
      }
      return { ok: true, intakeAvailable: true, authenticatedAs: user.login, repository: REPO_URL,
        intakeType: 'public-github-issue-review', registrationAvailable: false, membershipAvailable: false };
    } catch {
      return problem('intake_unavailable', 'Use your own existing GitHub CLI sign-in; the public intake repository must be available. No credential details are returned.');
    }
  }
  async function reconcile(requestId) {
    if (!requestIdValid(requestId)) return problem('invalid_request_id', 'Use the requestId returned by forge_prepare_application.');
    try {
      const issues = await ghJson(['issue', 'list', '--repo', REPO_URL, '--state', 'all', '--author', '@me',
        '--search', `${requestId} in:body`, '--limit', '100', '--json', 'number,url,body']);
      if (!Array.isArray(issues) || issues.length > 100) throw new Error('invalid_response');
      const matches = issues.filter(issue => record(issue) && Number.isSafeInteger(issue.number) && issue.number > 0
        && issueUrl(issue.url) && typeof issue.body === 'string' && issue.body.split('\n').includes(markerFor(requestId)))
        .map(issue => ({ number: issue.number, url: issue.url }));
      if (issues.length === 100) return problem('reconciliation_incomplete', 'The bounded search reached 100 results; do not submit until manually reconciled.', { requestId, matches });
      return { ok: true, requestId, matches, searchIsEventuallyConsistent: true,
        nextAction: matches.length ? 'Review the existing issue; do not create another.' : 'No indexed exact match found. Absence is not proof that an earlier attempt failed.' };
    } catch {
      return problem('reconciliation_unavailable', 'GitHub readback failed; do not retry an ambiguous submission.', { requestId });
    }
  }
  async function submit(args) {
    if (!ownKeys(args, ['application', 'requestId', 'publicProfileConsent']) || args.publicProfileConsent !== true) {
      return problem('public_consent_required', 'Publish only after the applicant explicitly consents to making this entire profile public.');
    }
    const prepared = prepare(args.application);
    if (!prepared.ok) return prepared;
    if (args.requestId !== prepared.requestId) return problem('request_id_mismatch', 'Prepare the exact profile and use its returned requestId.');
    const requestId = prepared.requestId;
    if (inFlight.has(requestId)) return problem('submission_in_progress', 'This request already has an in-process submission.', { requestId });
    if (attempted.size >= 128 && !attempted.has(requestId)) return problem('session_submission_limit', 'This local server reached its submission-attempt bound. Do not restart to retry an ambiguous request.');
    if (attempted.has(requestId)) return problem('reconcile_required', 'This server already attempted creation. Reconcile; do not automatically create again.', { requestId });
    inFlight.add(requestId);
    let directory;
    try {
      const ready = await readiness();
      if (!ready.ok) return ready;
      const existing = await reconcile(requestId);
      if (!existing.ok) return existing;
      if (existing.matches.length) return { ok: true, requestId, state: 'existing-review-request', issues: existing.matches, registrationState: 'not-registered' };
      directory = await mkdtemp(join(tmpdir(), 'apeforge-application-'));
      await chmod(directory, 0o700);
      const bodyPath = join(directory, 'application.md');
      await writeFile(bodyPath, prepared.issueBody, { mode: 0o600, flag: 'wx' });
      attempted.add(requestId); // No automatic retry once the mutation may have been sent.
      let output;
      try {
        output = await runGh(['issue', 'create', '--repo', REPO_URL, '--title', prepared.issueTitle, '--body-file', bodyPath]);
      } catch {
        return problem('submission_ambiguous', 'Creation failed or timed out and may have reached GitHub. Save requestId, reconcile and inspect GitHub; do not automatically retry.', { requestId });
      }
      const url = typeof output === 'string' ? output.trim() : '';
      if (!issueUrl(url)) return problem('submission_ambiguous', 'GitHub returned no recognized issue receipt. Reconcile before any further action.', { requestId });
      return { ok: true, requestId, state: 'submitted-for-review', issueUrl: url,
        registrationState: 'not-registered', membershipState: 'not-approved',
        note: 'A durable public review request, not registration, a listing, payment or membership.' };
    } catch {
      return problem('preparation_failed', 'Local preparation failed; no credential details are returned.', { requestId });
    } finally {
      inFlight.delete(requestId);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { readiness, reconcile, submit };
}

const applicationInput = { type: 'object', description: 'Raw public profile using application.example.json fields; no credentials or private wallet keys.' };
const tool = (name, description, properties = {}, required = [], readOnlyHint = true) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: !['forge_capabilities', 'forge_prepare_application', 'forge_validate_application'].includes(name) }
});
export const TOOLS = [
  tool('forge_capabilities', 'Local capabilities; no network call. Issue intake is distinct from registry membership.'),
  tool('forge_readiness', 'Check your existing gh sign-in and the fixed public GitHub intake repository.'),
  tool('forge_validate_application', 'Validate a raw public profile offline. Nothing is sent.', { application: applicationInput }, ['application']),
  tool('forge_prepare_application', 'Prepare public review issue + stable requestId offline. Save requestId before submission.', { application: applicationInput }, ['application']),
  tool('forge_reconcile_application', 'Bounded exact-marker search of your own issues in the fixed repo; indexing is eventually consistent.', { requestId: { type: 'string', pattern: '^forge-v1-[a-f0-9]{64}$' } }, ['requestId']),
  tool('forge_submit_application', 'Publish one public application-review issue, only with explicit public profile consent. Not registration or membership; no automatic retry.',
    { application: applicationInput, requestId: { type: 'string', pattern: '^forge-v1-[a-f0-9]{64}$' }, publicProfileConsent: { type: 'boolean', const: true } }, ['application', 'requestId', 'publicProfileConsent'], false)
];

export function createRpc(service = createService()) {
  let initialized = false;
  let ready = false;
  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  return async message => {
    if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
      || ('id' in message && !(typeof message.id === 'string' && message.id.length <= 128 || Number.isSafeInteger(message.id)))) {
      return error(null, -32600, 'Invalid Request');
    }
    const hasId = 'id' in message;
    const id = message.id;
    if (!hasId) {
      if (message.method === 'notifications/initialized' && initialized) ready = true;
      return null;
    }
    if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (message.method === 'initialize') {
      if (initialized) return error(id, -32600, 'Already initialized');
      const params = message.params;
      if (!record(params) || typeof params.protocolVersion !== 'string' || !record(params.capabilities)
        || !record(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        return error(id, -32602, 'Invalid initialization parameters');
      }
      initialized = true;
      return { jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} },
        serverInfo: { name: 'apeforge-forge-agent', version: '1.0.0' },
        instructions: 'Public GitHub application-review intake only. No registry registration, automatic membership, wallet signing, payments or locks.' } };
    }
    if (!ready) return error(id, -32002, 'Initialize and send notifications/initialized first');
    if (message.method === 'tools/list') {
      if (message.params !== undefined && !ownKeys(message.params, [])) return error(id, -32602, 'Invalid list parameters');
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (message.method !== 'tools/call') return error(id, -32601, 'Method not found');
    const params = message.params;
    if (!ownKeys(params, ['name', 'arguments']) || typeof params.name !== 'string') return error(id, -32602, 'Invalid tool parameters');
    const definition = TOOLS.find(item => item.name === params.name);
    if (!definition) return error(id, -32602, 'Unknown tool');
    const args = params.arguments ?? {};
    if (!ownKeys(args, Object.keys(definition.inputSchema.properties)) || definition.inputSchema.required.some(key => !(key in args))) {
      return error(id, -32602, 'Invalid tool arguments');
    }
    let result;
    try {
      switch (params.name) {
        case 'forge_capabilities': result = { ok: true, offlinePreparation: true, publicIssueIntake: true,
          repository: REPO_URL, requiresOwnGhAuth: true, requiresPublicConsent: true,
          registrationAvailable: false, membershipAvailable: false, paymentAvailable: false, lockAvailable: false,
          idempotency: 'stable-marker-best-effort-not-atomic', updateAvailable: false }; break;
        case 'forge_readiness': result = await service.readiness(); break;
        case 'forge_reconcile_application': result = await service.reconcile(args.requestId); break;
        case 'forge_submit_application': result = await service.submit(args); break;
        case 'forge_prepare_application': result = prepare(args.application); break;
        case 'forge_validate_application': {
          const checked = prepare(args.application);
          result = checked.ok ? { ok: true, valid: true, requestId: checked.requestId, sent: false } : checked;
          break;
        }
      }
    } catch { result = problem('tool_failed', 'The tool failed; no untrusted error text or credential details are returned.'); }
    const text = JSON.stringify(result);
    if (byteLength(text) > MAX_LINE - 512) return error(id, -32603, 'Result too large');
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: result.ok === false } };
  };
}

export async function startStdio(input = process.stdin, output = process.stdout) {
  const rpc = createRpc();
  let pending = Buffer.alloc(0);
  let oversized = false;
  let queue = Promise.resolve();
  let queued = 0;
  const send = result => { if (result) output.write(JSON.stringify(result) + '\n'); };
  const dispatch = line => {
    if (queued >= 32) { send({ jsonrpc: '2.0', id: null, error: { code: -32003, message: 'Too many pending requests' } }); return; }
    queued++;
    queue = queue.then(async () => {
      let message;
      try { message = JSON.parse(line.toString('utf8')); }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
      send(await rpc(message));
    }).catch(() => send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } })).finally(() => queued--);
  };
  for await (const chunk of input) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(10, offset);
      const end = newline === -1 ? data.length : newline;
      const part = data.subarray(offset, end);
      if (!oversized) {
        if (pending.length + part.length > MAX_LINE) { oversized = true; pending = Buffer.alloc(0); }
        else pending = Buffer.concat([pending, part]);
      }
      if (newline !== -1) {
        if (oversized) send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Message exceeds size limit' } });
        else dispatch(pending);
        pending = Buffer.alloc(0); oversized = false;
      }
      offset = end + 1;
    }
  }
  if (oversized || pending.length) send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Incomplete or oversized JSON-RPC message' } });
  await queue;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    process.stderr.write('ApeForge agent MCP requires Node.js 24 or newer.\n');
    process.exitCode = 1;
  } else await startStdio();
}
