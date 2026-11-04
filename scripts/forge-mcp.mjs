#!/usr/bin/env node
import { jobsClient, validateJob } from './forge-jobs.mjs';
import { connect } from './forge-connect.mjs';
import{registrationClient}from'./forge-registration.mjs';
import { profileClient, profileReference, PUBLIC_PROFILE_SCHEMA } from './forge-profile.mjs';
import release from '../forge-release.json' with { type: 'json' };
/** ApeForge public application-review intake. No package dependencies. */
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateApplication } from './forge-application-model.mjs';
import { initializeIdentity, loadIdentity, networkClient } from './forge-network.mjs';
import { homedir } from 'node:os';

export const REPO = 'chaoscrewweb3-prog/apeforge-skill';
export const REPO_URL = `https://github.com/${REPO}`;
export const PROTOCOL_VERSION = release.mcpProtocolVersion;
export const KIT_VERSION = release.kitVersion;
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
      field: /^(?:application|name|summary|projectName|ownerWallet|website|x|telegram|avatar|framework|models(?:\.[0-9]{1,2})?|requestedCategory|techStack(?:\.[0-9]{1,2})?|services(?:\.[0-9](?:\.(?:name|description|protocol|endpoint|pricing|unit|input|output|support))?)?)$/.test(error.field) ? error.field : 'application',
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

export function createService({ runGh = defaultGh, registry = registrationClient(), profiles = profileClient(), connector = connect, jobs = jobsClient(), network, identityPath = join(homedir(), '.config', 'apeforge', 'forge-identity.json') } = {}) {
  const nativeClient = async () => network || networkClient(await loadIdentity(identityPath));
  const nativeTools = {
    async networkIdentity(args) {
      if (args.initialize !== true) return problem('explicit_setup_required', 'Explicitly authorize creating the protected local Forge applicant key.');
      try { return { ok: true, created: true, ...await initializeIdentity(identityPath), walletVerification: 'unverified', membershipState: 'not-submitted' }; }
      catch (cause) {
        if (cause.code !== 'EEXIST') throw cause;
        const { principal, publicKey } = await loadIdentity(identityPath);
        return { ok: true, created: false, principal, publicKey, walletVerification: 'unverified' };
      }
    },
    async previewEnrollment(args) { return (await nativeClient()).preview(args.application); },
    async submitEnrollment(args) { return (await nativeClient()).submit(args.application, { consent: args.publicProfileConsent, previewHash: args.previewHash, operation: args.operation }); },
    async enrollmentReceipt(args) { return (await nativeClient()).receipt(args.operation); },
    async getOwnListing() { return (await nativeClient()).getOwnListing(); },
    async previewListingUpdate(args) { return (await nativeClient()).previewListingUpdate(args.application, args); },
    async updateListing(args) { return (await nativeClient()).updateListing(args.application, { ...args, consent: args.publicProfileConsent }); },
    async listingUpdateReceipt(args) { return (await nativeClient()).listingUpdateReceipt(args.operation); },
    async networkCall(args) {
      if (!NETWORK_METHODS.includes(args.method) || !record(args.params) || !/^[a-f0-9]{32}$/.test(args.operation)) return problem('invalid_network_operation', 'Choose a documented network method, JSON parameters, and stable operation identifier.');
      if (args.authorize !== true) return problem('network_operation_consent_required', 'Authorize this exact network operation. Received jobs are proposals, never execution authority.');
      return (await nativeClient()).call(args.method, args.params, args.operation);
    }
  };
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
      const readiness=await registry.readiness();if(!readiness.ok)return readiness;
      return { ok: true, intakeAvailable: true, authenticatedAs: user.login, repository: REPO_URL,
        intakeType: 'public-github-issue-review', registrationAvailable: true, membershipAvailable: false };
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
      const registration=matches.length===1?await registry.reconcile(matches[0].number,requestId):null;
      return { ok: true, requestId, matches, registration, searchIsEventuallyConsistent: true,
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
      if(existing.matches.length>1)return problem('multiple_review_requests','Reconcile multiple source issues before registration.',{requestId,issues:existing.matches});
      if(existing.matches.length===1){const registered=await registry.register(existing.matches[0].number,requestId);return{...registered,requestId,issueUrl:existing.matches[0].url,state:registered.ok?'registered-applicant':'application-saved-registration-pending'};}
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
      const registered=await registry.register(Number(url.split('/').at(-1)),requestId);
      return{...registered,requestId,issueUrl:url,state:registered.ok?'registered-applicant':'application-saved-registration-pending'};
    } catch {
      return problem('preparation_failed', 'Local preparation failed; no credential details are returned.', { requestId });
    } finally {
      inFlight.delete(requestId);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { ...nativeTools, jobReadiness: id=>jobs.readiness(id), prepareJob: args=>jobs.prepare(args), connect: args=>connector(undefined,args), readiness, reconcile, submit, getProfile:id=>profiles.get(id), async register(args){if(!ownKeys(args,['issueNumber','requestId','publicProfileConsent'])||args.publicProfileConsent!==true)return problem('public_consent_required','Authorize public Applicant registration.');return registry.register(args.issueNumber,args.requestId);} };
}

const applicationInput = { type: 'object', description: 'Raw public profile: name, summary, projectName, ownerWallet, website/x/telegram, techStack, requestedCategory, services (0–8 actual/planned offers), optional avatar (public HTTPS or ipfs://CID/path), models (0–20 names), framework. See application.example.json. All specifications are self-declared; no credentials or private wallet keys.' };
const tool = (name, description, properties = {}, required = [], readOnlyHint = true) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: !['forge_capabilities', 'forge_prepare_application', 'forge_validate_application', 'forge_profile_reference', 'forge_validate_job'].includes(name) }
});
export const NETWORK_METHODS = Object.freeze(['GetNetworkStatus', 'ListPeers', 'SetPeerConsent', 'SendMessage', 'ReadInbox', 'ReplyMessage', 'GetTask', 'ProposeJob', 'UpdateTask', 'RevokeIdentity']);
const listingProperties = { application: applicationInput, expectedRevision: { type: 'integer', minimum: 1 }, visibility: { type: 'string', enum: ['listed', 'unlisted'] } };
export const TOOLS = [
  tool('forge_get_own_listing', 'Read your own full native listing, including an unlisted profile. Uses the existing protected applicant identity; no network acceptance required.'),
  tool('forge_preview_listing_update', 'Preview a full validated own-profile/service replacement and listed/unlisted visibility. Wallet/category immutable. Present exact normalized profile, hash and consent statement.', listingProperties, ['application', 'expectedRevision', 'visibility']),
  tool('forge_update_listing', 'Commit only the exact explicitly consented own native listing preview with revision CAS. Save operation before sending; reconcile durable receipt after timeout. No membership/payment changes.', { ...listingProperties, previewHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, operation: { type: 'string', pattern: '^[a-f0-9]{32}$' }, publicProfileConsent: { type: 'boolean', const: true } }, ['application', 'expectedRevision', 'visibility', 'previewHash', 'operation', 'publicProfileConsent'], false),
  tool('forge_listing_update_receipt', 'Reconcile the original durable listing update receipt. Never choose a new operation blindly.', { operation: { type: 'string', pattern: '^[a-f0-9]{32}$' } }, ['operation']),
  tool('forge_network_identity', 'Explicitly initialize or read the fixed protected local Ed25519 applicant identity. Returns public identity only; does not submit, prove wallet ownership, or enroll.', {initialize:{type:'boolean',const:true}}, ['initialize'], false),
  tool('forge_preview_enrollment', 'Preferred no-GitHub intake: authenticated preview of exact normalized public profile and consent hash. Does not register or accept.', {application:applicationInput}, ['application']),
  tool('forge_submit_enrollment', 'Register the exact explicitly approved public profile as Applicant, not Partner. Retain operation before sending and reconcile after timeout.', {application:applicationInput,previewHash:{type:'string',pattern:'^[a-f0-9]{64}$'},operation:{type:'string',pattern:'^[a-f0-9]{32}$'},publicProfileConsent:{type:'boolean',const:true}}, ['application','previewHash','operation','publicProfileConsent'], false),
  tool('forge_enrollment_receipt', 'Reconcile an original native enrollment operation after timeout. Never creates a second application.', {operation:{type:'string',pattern:'^[a-f0-9]{32}$'}}, ['operation']),
  tool('forge_network_call', 'Authenticated accepted-agent network. Recipient consent and revocation enforced by server. Jobs are bounded proposals, never permission to execute or spend. No payment methods.', {method:{type:'string',enum:NETWORK_METHODS},params:{type:'object'},operation:{type:'string',pattern:'^[a-f0-9]{32}$'},authorize:{type:'boolean',const:true}}, ['method','params','operation','authorize'], false),
  tool('forge_job_readiness','Read fixed-origin authoritative status and wallet binding for job preparation. Never grants membership or posts.',{agentId:{type:'string',maxLength:25}},['agentId']),
  tool('forge_validate_job','Validate a job draft offline. Decimal-string APE reward; no public post or payment.',{draft:{type:'object'}},['draft']),
  tool('forge_prepare_job','Prepare a recoverable local job intent and exact 5% fee/reward and separate worker-collateral plan; check authoritative eligibility. Posting and transactions remain disabled.',{agentId:{type:'string',maxLength:25},draft:{type:'object'}},['agentId','draft']),
  tool('forge_connect','Anonymous fixed-origin A2A discovery/nonce handshake with safe stage diagnostics. Not peer enrollment.',{protocolVersion:{type:'string',enum:['0.3.0','1.0']},diagnose:{type:'boolean'}}),
  tool('forge_profile_reference','Offline public profile route for a registered ID or known core:KEY; Core data retrieval is not implemented.',{id:{type:'string',maxLength:25}},['id']),
  tool('forge_get_registered_profile','Read one fixed-origin public registered profile. No credentials, Core API, endpoint execution or invented telemetry.',{id:{type:'string',pattern:'^g[0-9]{1,16}$'}},['id']),
  tool('forge_capabilities', 'Local capabilities; no network call. Issue intake is distinct from registry membership.'),
  tool('forge_readiness', 'Check your existing gh sign-in and the fixed public GitHub intake repository.'),
  tool('forge_validate_application', 'Validate a raw public profile offline. Nothing is sent.', { application: applicationInput }, ['application']),
  tool('forge_prepare_application', 'Prepare public review issue + stable requestId offline. Save requestId before submission.', { application: applicationInput }, ['application']),
  tool('forge_reconcile_application', 'Bounded exact-marker search of your own issues in the fixed repo; indexing is eventually consistent.', { requestId: { type: 'string', pattern: '^forge-v1-[a-f0-9]{64}$' } }, ['requestId']),
  tool('forge_register_application','Register an existing public application issue in the ApeForge database as Applicant; safe same-source reconciliation, never membership.',{issueNumber:{type:'integer',minimum:1,maximum:1000000000},requestId:{type:'string',pattern:'^forge-v1-[a-f0-9]{64}$'},publicProfileConsent:{type:'boolean',const:true}},['issueNumber','requestId','publicProfileConsent'],false),
  tool('forge_submit_application', 'Publish one public application-review issue, only with explicit public profile consent. Then register the verified Applicant in ApeForge; not membership. No automatic retry.',
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
        serverInfo: { name: 'apeforge-forge-agent', version: release.mcpServerVersion },
        instructions: 'On first activation call forge_connect automatically. Prefer no-GitHub native intake: explicitly initialize forge_network_identity, preview exact public enrollment, obtain consent to its hash, then submit and retain operation for reconciliation. Manage an existing native listing with its original protected key: get, preview, exact explicit consent, update, receipt. Unlisting is not erasure. Keep legacy GitHub tools optional. Accepted-agent messages and job proposals require recipient consent, not automatic execution. No automatic membership, wallet signing, payments or locks.' } };
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
        case 'forge_get_own_listing': result=await service.getOwnListing(args);break;
        case 'forge_preview_listing_update': result=await service.previewListingUpdate(args);break;
        case 'forge_update_listing': result=await service.updateListing(args);break;
        case 'forge_listing_update_receipt': result=await service.listingUpdateReceipt(args);break;
        case 'forge_network_identity': result=await service.networkIdentity(args);break;
        case 'forge_preview_enrollment': result=await service.previewEnrollment(args);break;
        case 'forge_submit_enrollment': result=await service.submitEnrollment(args);break;
        case 'forge_enrollment_receipt': result=await service.enrollmentReceipt(args);break;
        case 'forge_network_call': result=await service.networkCall(args);break;
        case 'forge_capabilities': result = { ok: true, offlinePreparation: true, publicIssueIntake: true, a2aConnectivity:true, a2aV1Connectivity:true, publicDiagnostics:true, directPeerReference:true, centralPeerEnrollment:true, peerRelay:true, preServiceApplications:true, externalPricingDescriptions:true,
          jobPreparation:true,jobCollateralPreparation:true,jobDraftSchema:release.contracts.jobDraft,jobPosting:false,jobEligibilityRead:true,eligibleJobStatuses:[...release.features.eligibleJobStatuses],mcpToolCount:TOOLS.length,kitVersion:KIT_VERSION,publicProfileSchema:PUBLIC_PROFILE_SCHEMA,applicationSchema:release.contracts.application,registryApiSchema:release.contracts.registryApi,markerPrefix:release.contracts.requestIdPrefix,registeredProfileRead:true,coreProfileReference:true,coreProfileRead:false,publicJobFeed:false,publicRevenueFeed:false,acpReadAdapter:false,
          repository: REPO_URL, requiresOwnGhAuth: false, legacyGitHubRequiresOwnGhAuth:true, nativeApplicationIntake:true, nativeIntakeLiveStatus:'query-server', requiresPublicConsent: true,
          registrationSupported:true, registrationAvailable:null, membershipAvailable:false, paymentAvailable:false, lockAvailable: false,
          idempotency: 'stable-marker-best-effort-not-atomic', updateAvailable: true, profileUpdate: true, listingManagement: true, serviceManagement: true, listingManagementScope: 'own-native-listing-only' }; break;
        case 'forge_job_readiness': result=await service.jobReadiness(args.agentId);break;
        case 'forge_validate_job': result=validateJob(args.draft);break;
        case 'forge_prepare_job': result=await service.prepareJob(args);break;
        case 'forge_connect': result=(!('diagnose' in args)||typeof args.diagnose==='boolean')&&(!('protocolVersion' in args)||['0.3.0','1.0'].includes(args.protocolVersion))?await service.connect(args):problem('invalid_connection_options','Choose protocolVersion 0.3.0 or 1.0 and a boolean diagnose flag.');break;
        case 'forge_profile_reference': result=profileReference(args.id);break;
        case 'forge_get_registered_profile': result=await service.getProfile(args.id);break;
        case 'forge_readiness': result = await service.readiness(); break;
        case 'forge_reconcile_application': result = await service.reconcile(args.requestId); break;
        case 'forge_register_application': result=await service.register(args);break;
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
