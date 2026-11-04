import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRpc, createService, TOOLS, NETWORK_METHODS } from '../scripts/forge-mcp.mjs';

async function rpcFor(service) {
  const rpc = createRpc(service);
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return async (name, args) => {
    const response = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    return response.error ? response : JSON.parse(response.result.content[0].text);
  };
}
test('all original 13 tools retained and native methods have no transaction/payment primitive', () => {
  for (const name of ['forge_job_readiness', 'forge_validate_job', 'forge_prepare_job', 'forge_connect', 'forge_profile_reference', 'forge_get_registered_profile', 'forge_capabilities', 'forge_readiness', 'forge_validate_application', 'forge_prepare_application', 'forge_reconcile_application', 'forge_register_application', 'forge_submit_application']) assert.ok(TOOLS.some(tool => tool.name === name));
  assert.equal(TOOLS.length, 18);
  assert.deepEqual(NETWORK_METHODS, ['GetNetworkStatus', 'ListPeers', 'SetPeerConsent', 'SendMessage', 'ReadInbox', 'ReplyMessage', 'GetTask', 'ProposeJob', 'UpdateTask', 'RevokeIdentity']);
});
test('MCP initializes only after explicit setup, cannot read caller-supplied key path, never returns private key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-native-mcp-'));
  try {
    const key = join(dir, 'identity.json');
    const service = createService({ identityPath: key });
    const call = await rpcFor(service);
    await assert.rejects(access(key));
    assert.equal((await call('forge_network_identity', { initialize: false })).code, 'explicit_setup_required');
    await assert.rejects(access(key));
    assert.ok((await call('forge_network_identity', { initialize: true, path: '/private/random' })).error);
    const identity = await call('forge_network_identity', { initialize: true });
    assert.equal(identity.created, true);
    assert.equal(identity.privateKey, undefined);
    assert.equal((await call('forge_network_identity', { initialize: true })).principal, identity.principal);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('native intake forwarding uses optional network dependency and never calls gh', async () => {
  const calls = [];
  const network = {
    preview: async application => { calls.push(['preview', application]); return { ok: true, consentRequired: true }; },
    submit: async (application, consent) => { calls.push(['submit', application, consent]); return { ok: true, status: 'applicant' }; },
    receipt: async operation => { calls.push(['receipt', operation]); return { ok: true, status: 'applicant' }; },
    call: async (...args) => { calls.push(['call', ...args]); return { ok: true }; }
  };
  const call = await rpcFor(createService({ network, runGh: async () => { throw Error('GitHub must not run'); } }));
  const application = { name: 'profile' }, operation = 'ab'.repeat(16), previewHash = 'cd'.repeat(32);
  assert.equal((await call('forge_preview_enrollment', { application })).consentRequired, true);
  await call('forge_submit_enrollment', { application, operation, previewHash, publicProfileConsent: true });
  assert.deepEqual(calls[1], ['submit', application, { consent: true, operation, previewHash }]);
  await call('forge_enrollment_receipt', { operation });
  assert.deepEqual(calls[2], ['receipt', operation]);
  assert.equal((await call('forge_network_call', { method: 'SendMessage', params: { to: 'a123', text: 'hello' }, operation, authorize: false })).code, 'network_operation_consent_required');
  assert.equal((await call('forge_network_call', { method: 'Pay', params: {}, operation, authorize: true })).code, 'invalid_network_operation');
  assert.equal(calls.length, 3);
  await call('forge_network_call', { method: 'SendMessage', params: { to: 'a123', text: 'hello' }, operation, authorize: true });
  assert.equal(calls.length, 4);
});
