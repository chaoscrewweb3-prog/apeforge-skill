import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { prepare, createService, createRpc, startStdio, REPO, REPO_URL } from '../scripts/forge-mcp.mjs';

const sample = JSON.parse(await readFile(new URL('../application.example.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(sample);
const prepared = prepare(sample);
function fake({ issues = [], create = async () => `${REPO_URL}/issues/7\n`, fail = false } = {}) {
  const calls = [];
  const registry={readiness:async()=>({ok:true,registrationAvailable:true}),reconcile:async()=>({ok:true,registered:false}),register:async(n,requestId)=>({ok:true,registered:true,status:'applicant',id:'g1007',revision:1,requestId,agentUrl:'https://app.apeforge.fun/app/forge-agent.html?id=g1007',projectUrl:'https://app.apeforge.fun/app/forge-project.html?id=p'+'1'.repeat(24),membershipState:'not-approved'})};
  return { calls, registry, runGh: async args => {
    calls.push(args);
    if (fail) throw new Error('ghp_PRIVATE_CREDENTIAL_NEVER_OUTPUT');
    if (args[0] === 'api' && args.includes('user')) return JSON.stringify({ login: 'applicant' });
    if (args[0] === 'api') return JSON.stringify({ full_name: REPO, private: false, has_issues: true, archived: false });
    assert.equal(args[3], REPO_URL);
    if (args[1] === 'list') return JSON.stringify(issues);
    if (args[1] === 'create') return create(args);
    throw new Error('unexpected command');
  } };
}
const submitArgs = () => ({ application: copy(), requestId: prepared.requestId, publicProfileConsent: true });

test('canonical valid prep is offline, normalizes field order and does not grant membership', () => {
  assert.equal(prepared.ok, true);
  assert.match(prepared.requestId, /^forge-v1-[a-f0-9]{64}$/);
  assert.equal(prepared.registrationState, 'not-registered');
  assert.equal(prepare(Object.fromEntries(Object.entries(sample).reverse())).requestId, prepared.requestId);
  const edited = copy(); edited.summary += ' More';
  assert.notEqual(prepare(edited).requestId, prepared.requestId);
});

test('reject invalid fields, credential URL and oversized body without echoing secrets', () => {
  const invalid = copy(); invalid.privateKey = 'secret-value';
  const result = prepare(invalid);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
  const keyedSecret = copy(); keyedSecret.ghp_SECRET_IN_UNKNOWN_KEY = 'not-public';
  assert.equal(JSON.stringify(prepare(keyedSecret)).includes('ghp_SECRET_IN_UNKNOWN_KEY'), false);
  invalid.privateKey = undefined;
  const url = copy(); url.services[0].endpoint = 'https://user:password@apeforge.fun/mcp';
  assert.equal(prepare(url).ok, false);
  const giant = copy(); giant.summary = 'x'.repeat(40000);
  assert.equal(prepare(giant).code, 'body_too_large');
});

test('public consent, exact request marker and fixed fields precede every command', async () => {
  const transport = fake(); const service = createService(transport);
  const args = submitArgs(); args.publicProfileConsent = false;
  assert.equal((await service.submit(args)).code, 'public_consent_required');
  args.publicProfileConsent = true; args.requestId = 'forge-v1-' + '0'.repeat(64);
  assert.equal((await service.submit(args)).code, 'request_id_mismatch');
  assert.equal((await service.submit({ ...submitArgs(), repo: 'attacker/repo' })).code, 'public_consent_required');
  assert.equal(transport.calls.length, 0);
});

test('missing auth/repository is unavailable and subprocess diagnostics never leak', async () => {
  const transport = fake({ fail: true }); const service = createService(transport);
  const result = await service.submit(submitArgs());
  assert.equal(result.code, 'intake_unavailable');
  assert.equal(JSON.stringify(result).includes('ghp_'), false);
  assert.equal(transport.calls.some(args => args[1] === 'create'), false);
});

test('successful creation uses fixed arguments, private body file, literal title, cleans file and blocks retry', async () => {
  let temporary;
  const application = copy(); application.name = 'Agent $(no-shell) `literal`';
  const preview = prepare(application);
  const transport = fake({ create: async args => {
    temporary = args.at(-1);
    assert.equal(args[args.indexOf('--title') + 1], `Forge application: ${application.name}`);
    assert.equal((await stat(temporary)).mode & 0o777, 0o600);
    assert.equal((await readFile(temporary, 'utf8')), preview.issueBody);
    return `${REPO_URL}/issues/7\n`;
  } });
  const service = createService(transport);
  const args = { application, requestId: preview.requestId, publicProfileConsent: true };
  const result = await service.submit(args);
  assert.equal(result.state, 'registered-applicant');
  assert.equal(result.registered,true);
  assert.equal(result.issueUrl, `${REPO_URL}/issues/7`);
  assert.equal(result.membershipState, 'not-approved');
  await assert.rejects(stat(temporary), { code: 'ENOENT' });
  assert.equal((await service.submit(args)).code, 'reconcile_required');
  assert.equal(transport.calls.filter(args => args[1] === 'create').length, 1);
});

test('reconcile exact markers only, own author, closed included, and existing request prevents duplicate', async () => {
  const transport = fake({ issues: [
    { number: 8, url: `${REPO_URL}/issues/8`, body: `text ${prepared.requestId}` },
    { number: 9, url: `${REPO_URL}/issues/9`, body: `<!-- ${prepared.requestId} -->\ncontent` },
    { number: 10, url: 'https://evil.invalid/issues/10', body: `<!-- ${prepared.requestId} -->` }
  ] });
  const service = createService(transport);
  const result = await service.submit(submitArgs());
  assert.equal(result.state, 'registered-applicant');
  assert.equal(result.issueUrl,`${REPO_URL}/issues/9`);
  const args = transport.calls.find(args => args[1] === 'list');
  assert.equal(args[args.indexOf('--author') + 1], '@me');
  assert.equal(args[args.indexOf('--state') + 1], 'all');
  assert.equal(args[args.indexOf('--limit') + 1], '100');
  assert.equal(transport.calls.some(args => args[1] === 'create'), false);
});

test('ambiguous creation and foreign receipt cause no automatic retries and no secret output', async () => {
  for (const create of [async () => { throw new Error('Bearer secret-do-not-echo'); }, async () => 'https://evil.invalid/issues/2']) {
    const transport = fake({ create }); const service = createService(transport);
    const result = await service.submit(submitArgs());
    assert.equal(result.code, 'submission_ambiguous');
    assert.equal(JSON.stringify(result).includes('secret-do-not-echo'), false);
    assert.equal((await service.submit(submitArgs())).code, 'reconcile_required');
    assert.equal(transport.calls.filter(args => args[1] === 'create').length, 1);
  }
});

test('bounded reconciliation blocks create at the limit, and malformed request IDs invoke nothing', async () => {
  const transport = fake({ issues: Array.from({ length: 100 }, () => ({ number: 1, url: `${REPO_URL}/issues/1`, body: 'unrelated' })) });
  const service = createService(transport);
  assert.equal((await service.reconcile('../arbitrary')).code, 'invalid_request_id');
  assert.equal(transport.calls.length, 0);
  assert.equal((await service.submit(submitArgs())).code, 'reconciliation_incomplete');
  assert.equal(transport.calls.some(args => args[1] === 'create'), false);
});

test('concurrent in-process same-marker submit sends at most one create', async () => {
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const transport = fake({ create: async () => { await blocked; return `${REPO_URL}/issues/7`; } });
  const service = createService(transport);
  const first = service.submit(submitArgs());
  const second = await service.submit(submitArgs());
  assert.equal(second.code, 'submission_in_progress');
  release(); await first;
  assert.equal(transport.calls.filter(args => args[1] === 'create').length, 1);
});

test('MCP lifecycle, tools and tool-level errors use JSON-RPC without executing supplied commands', async () => {
  const transport = fake(); const rpc = createRpc(createService(transport));
  const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  assert.equal((await rpc(req(1, 'tools/list'))).error.code, -32002);
  assert.equal((await rpc(req(2, 'initialize', {}))).error.code, -32602);
  assert.equal((await rpc(req(3, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }))).result.protocolVersion, '2025-11-25');
  assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const listed = await rpc(req(4, 'tools/list'));
  assert.equal(listed.result.tools.length, 7);
  assert.equal((await rpc(req(5, 'tools/call', { name: 'run_shell', arguments: {} }))).error.code, -32602);
  const result = await rpc(req(6, 'tools/call', { name: 'forge_prepare_application', arguments: { application: sample } }));
  assert.equal(JSON.parse(result.result.content[0].text).requestId, prepared.requestId);
  assert.equal((await rpc([])).error.code, -32600);
  assert.equal(transport.calls.length, 0);
});

test('stdio malformed, batch, oversize and incomplete input return bounded protocol errors', async () => {
  const chunks = ['not-json\n', '[]\n', 'x'.repeat(70000) + '\n', '{'];
  let out = '';
  const output = new Writable({ write(chunk, encoding, callback) { out += chunk.toString(); callback(); } });
  await startStdio(Readable.from(chunks), output);
  const rows = out.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(item => item.error.code).sort(), [-32700, -32700, -32700, -32600].sort());
  assert.equal(out.length < 1024, true);
});
