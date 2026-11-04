import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, hash, identityFromPrivateKey, networkClient, normalizeApplication } from '../scripts/forge-network.mjs';
import { LISTING_CONSENT } from '../scripts/forge-listing.mjs';
import { createRpc, createService, TOOLS } from '../scripts/forge-mcp.mjs';
const base = normalizeApplication({ name: 'Offline listing', summary: 'Synthetic test profile', ownerWallet: '0x1111111111111111111111111111111111111111', website: 'https://apeforge.fun/', techStack: ['Node.js'], requestedCategory: 'partner', services: [] });
const operation = 'ab'.repeat(16);
const urls = { agentUrl: 'https://app.apeforge.fun/app/forge-agent.html?id=g1', projectUrl: 'https://app.apeforge.fun/app/forge-project.html?id=p' + 'ab'.repeat(12), sourceUrl: 'https://app.apeforge.fun/api/forge/v1/applications/g1' };
const digest = (application, revision = 1, visibility = 'listed', id = 'g1') => hash({ domain: 'forge-listing-update-v1', agentId: id, expectedRevision: revision, visibility, application });
function fixture(change = value => value) {
  const requests = [];
  const identity = identityFromPrivateKey(generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const key = createPublicKey({ key: Buffer.from(identity.publicKey, 'base64url'), format: 'der', type: 'spki' });
  const client = networkClient(identity, { fetcher: async (url, options) => {
    const envelope = JSON.parse(options.body).params.message.parts[0].data.forgeNetwork;
    const { signature, ...unsigned } = envelope;
    assert.equal(verify(null, Buffer.from(canonicalJson({ domain: 'forge-network-v1', ...unsigned })), key, Buffer.from(signature, 'base64url')), true);
    requests.push(envelope);
    let result = { ok: true, id: 'g1', revision: 1, application: base, visibility: 'listed', networkStatus: 'pending' };
    if (envelope.method === 'PreviewListingUpdate') result = { ok: true, id: 'g1', ...envelope.params, previewHash: digest(envelope.params.application, envelope.params.expectedRevision, envelope.params.visibility), consentStatement: LISTING_CONSENT, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    if (envelope.method === 'UpdateListing') result = { ok: true, id: 'g1', revision: 2, updated: true, visibility: envelope.params.visibility, networkStatus:'pending', ...urls };
    if (envelope.method === 'GetListingUpdateReceipt') result = { ok: true, id: 'g1', revision: 2, updated: true, visibility: 'unlisted', networkStatus:'pending', ...urls };
    result = change(result, envelope);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: envelope.operation, result: { message: { role: 'ROLE_AGENT', messageId: 'reply', contextId: envelope.operation, parts: [{ data: result }] } } }));
  } });
  return { client, requests };
}
test('signed transport supports Applicant own read, exact replacement, hide and durable receipt without network approval', async () => {
  const { client, requests } = fixture();
  assert.equal((await client.getOwnListing()).networkStatus, 'pending');
  const application = { ...base, name: 'Edited listing' };
  const preview = await client.previewListingUpdate(application, { expectedRevision: 1, visibility: 'unlisted' });
  assert.equal(preview.previewHash, digest(application, 1, 'unlisted'));
  const result = await client.updateListing(application, { expectedRevision: 1, visibility: 'unlisted', previewHash: preview.previewHash, operation, consent: true });
  assert.equal(result.revision, 2);
  const commit = requests.find(r => r.method === 'UpdateListing');
  assert.equal(commit.operation, operation);
  assert.deepEqual(commit.params, { application, expectedRevision: 1, visibility: 'unlisted', previewHash: preview.previewHash, consent: true });
  await client.listingUpdateReceipt(operation);
  assert.deepEqual(requests.at(-1).params, { operation });
  assert.equal(requests.some(r => /SubmitApplication|SetPeerConsent/.test(r.method)), false);
});
for (const [name, mutate] of [
  ['profile', r => ({ ...r, application: { ...r.application, name: 'Mutated' } })],
  ['ID', r => ({ ...r, id: 'g2' })],
  ['revision', r => ({ ...r, expectedRevision: 2 })],
  ['visibility', r => ({ ...r, visibility: 'unlisted' })],
  ['hash', r => ({ ...r, previewHash: '00'.repeat(32) })],
  ['consent', r => ({ ...r, consentStatement: 'different consent' })],
  ['expiry', r => ({ ...r, expiresAt: '2000-01-01T00:00:00Z' })],
]) test('reject server preview with altered ' + name, async () => {
  const { client } = fixture((r, e) => e.method === 'PreviewListingUpdate' ? mutate(r) : r);
  await assert.rejects(client.previewListingUpdate(base, { expectedRevision: 1, visibility: 'listed' }), { code: 'invalid_listing_preview' });
});
test('no mutation on absent consent, mismatched hash, immutable wallet/category, malformed visibility or stale revision', async () => {
  const { client, requests } = fixture();
  await assert.rejects(client.updateListing(base, { expectedRevision: 1, visibility: 'listed', previewHash: digest(base), operation }), { code: 'exact_listing_consent_required' });
  assert.equal(requests.length, 0);
  await assert.rejects(client.updateListing(base, { expectedRevision: 1, visibility: 'listed', previewHash: 'ff'.repeat(32), operation, consent: true }), { code: 'exact_listing_consent_required' });
  for (const application of [{ ...base, ownerWallet: '0x2222222222222222222222222222222222222222' }, { ...base, requestedCategory: 'community' }]) await assert.rejects(client.previewListingUpdate(application, { expectedRevision: 1, visibility: 'listed' }), { code: 'immutable_listing_field' });
  await assert.rejects(client.previewListingUpdate(base, { expectedRevision: 1, visibility: 'private' }), { code: 'invalid_listing_update' });
  assert.equal((await client.previewListingUpdate(base, { expectedRevision: 2, visibility: 'listed' })).code, 'revision_conflict');
  assert.equal(requests.some(r => r.method === 'UpdateListing'), false);
});
test('services are validated complete replacements for add, edit and remove, including planned endpoint', async () => {
  const { client } = fixture();
  const service = { name: 'Planned research', description: 'Research summaries', protocol: 'rest', endpoint: '', status: 'planned', pricing: 'free', unit: 'request', input: 'Topic', output: 'Summary', support: 'https://apeforge.fun/' };
  for (const services of [[service], [{ ...service, name: 'Edited research' }], []]) {
    const application = normalizeApplication({ ...base, services });
    assert.deepEqual((await client.previewListingUpdate(application, { expectedRevision: 1, visibility: 'listed' })).application.services, application.services);
  }
  await assert.rejects(client.previewListingUpdate({ ...base, services: Array(9).fill(service) }, { expectedRevision: 1, visibility: 'listed' }), { code: 'invalid_application' });
});
test('update uncertainty preserves original operation and correct receipt method, with no automatic retry', async () => {
  const { client, requests } = fixture((r,e) => { if (e.method === 'UpdateListing') throw Error('timeout'); return r; });
  const result = await client.updateListing(base, { expectedRevision: 1, visibility: 'listed', previewHash: digest(base), operation, consent: true });
  assert.equal(result.operation, operation); assert.equal(result.reconcileMethod, 'GetListingUpdateReceipt');
  assert.equal(requests.filter(r => r.method === 'UpdateListing').length, 1);
});
async function rpcFor(service) {
  const rpc = createRpc(service);
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return async (name, args = {}) => { const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }); return r.error ? r : JSON.parse(r.result.content[0].text); };
}
test('four dedicated MCP tools, no generic update bypass, no key initialization on own read', async () => {
  assert.equal(TOOLS.length, 22);
  const dir = await mkdtemp(join(tmpdir(), 'forge-listing-no-key-'));
  try {
    const key = join(dir, 'missing.json'); const call = await rpcFor(createService({ identityPath: key }));
    assert.equal((await call('forge_get_own_listing')).code, 'tool_failed');
    await assert.rejects(access(key));
    assert.ok((await call('forge_get_own_listing', { agentId: 'g2' })).error);
    assert.equal((await call('forge_network_call', { method: 'UpdateListing', params: {}, operation, authorize: true })).code, 'invalid_network_operation');
    const c = await call('forge_capabilities');
    for (const name of ['updateAvailable', 'profileUpdate', 'listingManagement', 'serviceManagement']) assert.equal(c[name], true);
    assert.equal(c.paymentAvailable, false); assert.equal(c.membershipAvailable, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('MCP forwards exact listing consent and stable receipt operation through dedicated tools', async () => {
  const calls = []; const network = Object.fromEntries(['getOwnListing','previewListingUpdate','updateListing','listingUpdateReceipt'].map(name => [name, async (...args) => { calls.push([name,...args]); return { ok: true }; }]));
  const call = await rpcFor(createService({ network }));
  await call('forge_get_own_listing');
  const args = { application: base, expectedRevision: 1, visibility: 'listed', previewHash: digest(base), operation, publicProfileConsent: true };
  await call('forge_preview_listing_update', { application: base, expectedRevision: 1, visibility: 'listed' });
  await call('forge_update_listing', args); await call('forge_listing_update_receipt', { operation });
  assert.equal(calls[2][2].consent, true); assert.equal(calls[2][2].previewHash, digest(base)); assert.deepEqual(calls[3], ['listingUpdateReceipt', operation]);
});

test('preview accepts bounded server clock skew but rejects expiry beyond sixty second tolerance', async () => {
  const options = { expectedRevision: 1, visibility: 'listed' };
  const valid = fixture((r,e) => e.method === 'PreviewListingUpdate' ? { ...r, expiresAt: new Date(Date.now() + 86401000).toISOString() } : r);
  assert.equal((await valid.client.previewListingUpdate(base, options)).ok, true);
  const invalid = fixture((r,e) => e.method === 'PreviewListingUpdate' ? { ...r, expiresAt: new Date(Date.now() + 86500000).toISOString() } : r);
  await assert.rejects(invalid.client.previewListingUpdate(base, options), { code: 'invalid_listing_preview' });
});
for (const [field, value] of [['networkStatus','admin'], ['id','g2'], ['revision',0], ['visibility','private'], ['updated',false], ['agentUrl','https://evil.example/'], ['projectUrl','https://evil.example/?id=p' + 'ab'.repeat(12)], ['sourceUrl','https://app.apeforge.fun/api/forge/v1/applications/g2']]) test('malformed update and receipt ' + field + ' is never reported as success', async () => {
  const { client } = fixture((r,e) => ['UpdateListing','GetListingUpdateReceipt'].includes(e.method) ? { ...r, [field]: value } : r);
  const update = await client.updateListing(base, { expectedRevision: 1, visibility: 'listed', previewHash: digest(base), operation, consent: true });
  const receipt = await client.listingUpdateReceipt(operation);
  for (const result of [update, receipt]) {
    assert.equal(result.ok, false); assert.equal(result.code, 'invalid_listing_update_receipt');
    assert.equal(result.listingOperation, operation); assert.equal(result.reconcileMethod, 'GetListingUpdateReceipt');
  }
});
test('update requires exact next revision and requested visibility; durable receipt permits older revision after later updates', async () => {
  for (const mutate of [r => ({ ...r, revision: 3 }), r => ({ ...r, visibility: 'unlisted' })]) {
    const { client } = fixture((r,e) => e.method === 'UpdateListing' ? mutate(r) : r);
    assert.equal((await client.updateListing(base, { expectedRevision: 1, visibility: 'listed', previewHash: digest(base), operation, consent: true })).ok, false);
  }
  const { client, requests } = fixture((r,e) => e.method === 'GetOwnListing' ? { ...r, revision: 5, visibility: 'listed' } : r);
  const receipt = await client.listingUpdateReceipt(operation);
  assert.equal(receipt.ok, true); assert.equal(receipt.revision, 2); assert.equal(receipt.visibility, 'unlisted');
  assert.deepEqual(requests.map(r => r.method), ['GetOwnListing','GetListingUpdateReceipt']);
});
