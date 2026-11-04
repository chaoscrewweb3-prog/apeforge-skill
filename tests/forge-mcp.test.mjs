import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { prepare, createService, createRpc, startStdio, REPO, REPO_URL } from '../scripts/forge-mcp.mjs';
import { profileClient, profileReference, CORE_IDS } from '../scripts/forge-profile.mjs';

const sample = JSON.parse(await readFile(new URL('./legacy-application.json', import.meta.url), 'utf8'));
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
  assert.equal(prepared.requestId, 'forge-v1-b2ecde36f7088aa684c8619f5145f7192117716e1f50b5305086b8532a0fff55');
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
  assert.equal(listed.result.tools.length, 18);
  for(const name of ['forge_capabilities','forge_readiness','forge_validate_application','forge_prepare_application','forge_reconcile_application','forge_register_application','forge_submit_application','forge_profile_reference','forge_get_registered_profile'])assert(listed.result.tools.some(t=>t.name===name));
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

const profileUrl='https://app.apeforge.fun/api/forge/v1/agents/g123';
function publicProfile(services=sample.services){return {id:'g123',revision:2,name:sample.name,overview:sample.summary,project:{id:'p'+'a'.repeat(24),name:sample.projectName},membership:{status:'applicant'},profile:{...copy(),services},source:{type:'github-public-application',url:REPO_URL+'/issues/7'},createdAt:'2026-11-02T12:00:00.000Z',updatedAt:'2026-11-03T12:00:00.000Z'};}
function response(value,{status=200,url=profileUrl,headers={},redirected=false}={}){const r=new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});Object.defineProperties(r,{url:{value:url},redirected:{value:redirected}});return r;}

test('offline references accept exactly known Core keys with fragment routes, never imply Core retrieval',()=>{
  assert.equal(CORE_IDS.length,15);
  for(const key of CORE_IDS){const r=profileReference('core:'+key);assert.equal(r.profileUrl,'https://app.apeforge.fun/app/forge-agent.html#core='+key);assert.equal(r.dataRetrieval,'not_implemented');}
  assert.equal(profileReference('core:UNKNOWN').ok,false);
  assert.equal(profileReference('https://evil.invalid').ok,false);
  assert.equal(profileReference('g123').profileUrl,'https://app.apeforge.fun/app/forge-agent.html?id=g123');
});

test('registered read uses fixed credentialless GET, preserves public declarations and unknown metrics',async()=>{
  const client=profileClient(async(url,options)=>{assert.equal(url,profileUrl);assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert(options.signal instanceof AbortSignal);assert.deepEqual(options.headers,{Accept:'application/json'});assert.equal(options.body,undefined);return response(publicProfile());});
  const r=await client.get('g123');assert.equal(r.ok,true);assert.equal(r.schemaVersion,1);assert.equal(r.profileRevision,2);assert.equal(r.declaredServiceCount,1);assert.equal(r.source.kind,'applicant-declared');assert.deepEqual(r.publicRecord,publicProfile());
  for(const name of ['completedJobs','agentsHired','successRate','responseTime','uptime']){assert.equal(r.metrics[name].value,null);assert.equal(r.metrics[name].status,'not_connected');assert.equal(r.metrics[name].sampleCount,null);}
  assert.deepEqual(r.metrics.serviceRevenueReceived.amounts,[]);assert.equal(r.metrics.serviceRevenueReceived.status,'not_connected');assert.equal(r.coverage.complete,false);
});

test('genuine empty declared service list is zero, never zero jobs or zero earnings',async()=>{
  const r=await profileClient(async()=>response(publicProfile([]))).get('g123');assert.equal(r.ok,true);assert.equal(r.declaredServiceCount,0);assert.equal(r.metrics.completedJobs.value,null);assert.equal(r.metrics.serviceRevenueReceived.status,'not_connected');
});

test('invalid IDs/Core reads invoke no transport and not-found remains unknown',async()=>{
  let calls=0;const c=profileClient(async()=>{calls++;return response({}, {status:404});});
  for(const id of ['core:ATLAS','../g123','g1?x=2','https://evil.invalid',3])assert.equal((await c.get(id)).code,'invalid_agent_id');
  assert.equal(calls,0);const r=await c.get('g123');assert.equal(r.code,'profile_not_found');assert.equal(r.profileState,'unknown');assert.equal(r.metrics,undefined);
});

test('malformed records, wrong identities and content type never become success',async()=>{
  for(const change of [v=>v.id='g456',v=>v.revision=0,v=>v.profile.services=[{}],v=>v.source.url='https://evil.invalid',v=>v.membership.status='suspended']){const value=publicProfile();change(value);assert.equal((await profileClient(async()=>response(value)).get('g123')).code,'invalid_profile_response');}
  assert.equal((await profileClient(async()=>response('{')).get('g123')).ok,false);
  assert.equal((await profileClient(async()=>response(publicProfile(),{headers:{'Content-Type':'text/html'}})).get('g123')).ok,false);
});

test('oversized declared or streamed bodies are rejected, not parsed as empty history',async()=>{
  for(const r of [response('{}',{headers:{'Content-Length':'49153'}}),response('x'.repeat(49153))]){const result=await profileClient(async()=>r).get('g123');assert.equal(result.code,'profile_too_large');assert.equal(result.profileState,'unknown');}
});

test('redirects and foreign final origins are rejected even by a nonconforming fetcher',async()=>{
  for(const options of [{url:'https://evil.invalid/api/forge/v1/agents/g123'},{redirected:true},{status:302}])assert.equal((await profileClient(async()=>response(publicProfile(),options)).get('g123')).code,'profile_response_rejected');
});

test('timeout/provider failures return sanitized unknown, never echo diagnostics',async()=>{
  for(const error of [new DOMException('private diagnostic','TimeoutError'),new Error('Bearer SECRET')]){const result=await profileClient(async()=>{throw error;}).get('g123');assert.equal(result.code,'profile_unavailable');assert.equal(result.profileState,'unknown');assert(!JSON.stringify(result).includes('SECRET'));assert(!JSON.stringify(result).includes('private diagnostic'));}
});

test('actual stdio handshake advertises 1.8.0, eighteen tools and separate schema/feature versions',async()=>{
  const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'forge_capabilities',arguments:{}}},{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'forge_profile_reference',arguments:{id:'core:MUSE'}}}];
  let out='';await startStdio(Readable.from(messages.map(v=>JSON.stringify(v)+'\n')),new Writable({write(chunk,encoding,done){out+=chunk;done();}}));const rows=out.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].result.serverInfo.version,'1.8.0');assert.equal(rows[0].result.protocolVersion,'2025-11-25');assert.equal(rows[1].result.tools.length,18);const c=JSON.parse(rows[2].result.content[0].text);assert.equal(c.kitVersion,'1.8.0');assert.equal(c.applicationSchema,1);assert.equal(c.publicProfileSchema,1);assert.equal(c.coreProfileRead,false);assert.equal(c.publicJobFeed,false);assert.equal(c.publicRevenueFeed,false);assert.equal(c.acpReadAdapter,false);assert.equal(c.paymentAvailable,false);assert.equal(c.updateAvailable,false);assert.equal(JSON.parse(rows[3].result.content[0].text).dataRetrieval,'not_implemented');
});
test('native signed application sources are bound to the exact Forge ID and remain key-control-only',async()=>{
 const v=publicProfile();v.source={type:'forge-signed-application',url:'https://app.apeforge.fun/api/forge/v1/applications/g123',author:'a'+'1'.repeat(32),verified:'signing-key-control-only'};
 const result=await profileClient(async()=>response(v)).get('g123');assert.equal(result.ok,true);assert.match(result.source.verification,/signing-key-control-only/);assert.equal(result.metrics.completedJobs.value,null);
 for(const change of[x=>x.source.url='https://app.apeforge.fun/api/forge/v1/applications/g456',x=>x.source.verified='wallet-verified',x=>x.source.author='unverified']){const invalid=structuredClone(v);change(invalid);assert.equal((await profileClient(async()=>response(invalid)).get('g123')).code,'invalid_profile_response');}
});
