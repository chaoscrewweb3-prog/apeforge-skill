import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, stat, chmod, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, hash, initializeIdentity, loadIdentity, identityFromPrivateKey, signRequest, networkClient, normalizeApplication, NETWORK_URL, rotateIdentity } from '../scripts/forge-network.mjs';

const application = { name: 'AXO é research', summary: 'Public research agent', ownerWallet: '0x1111111111111111111111111111111111111111', website: 'https://apeforge.fun/', techStack: ['Node.js'], requestedCategory: 'partner', services: [] };
const makeIdentity = () => identityFromPrivateKey(generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
const operation = 'ab'.repeat(16);
const response = (result, operation) => new Response(JSON.stringify({jsonrpc:'2.0',id:operation,result:{message:{role:'ROLE_AGENT',messageId:'test-reply',contextId:operation,parts:[{data:result}]}}}), { headers: { 'Content-Type': 'application/json' } });

test('canonical JSON normalizes recursive ordering, preserves unicode, rejects non-JSON values', () => {
  assert.equal(canonicalJson({ z: ['é', { y: 2, a: true }], a: null }), '{"a":null,"z":["é",{"a":true,"y":2}]}');
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
  for (const invalid of [undefined, NaN, Infinity, 1.5, new Date(), { a: undefined }]) assert.throws(() => canonicalJson(invalid));
});
test('key initialization is exclusive, restricted and reveals no private key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-identity-'));
  try {
    const path = join(dir, 'key.json');
    const pub = await initializeIdentity(path);
    assert.deepEqual(Object.keys(pub).sort(), ['principal', 'publicKey']);
    assert.match(pub.principal, /^a[0-9a-f]{32}$/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const identity = await loadIdentity(path);
    assert.equal(identity.publicKey, pub.publicKey);
    await assert.rejects(initializeIdentity(path), { code: 'EEXIST' });
    const before = await readFile(path, 'utf8');
    assert.equal((await loadIdentity(path)).principal, pub.principal);
    assert.equal(await readFile(path, 'utf8'), before);
    await chmod(path, 0o644);
    await assert.rejects(loadIdentity(path), { code: 'unsafe_identity_file' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('identity loader rejects symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-identity-'));
  try {
    await initializeIdentity(join(dir, 'key'));
    await symlink(join(dir, 'key'), join(dir, 'link'));
    await assert.rejects(loadIdentity(join(dir, 'link')), { code: 'unsafe_identity_file' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('identity loader rejects hardlinked control keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-identity-'));
  try {
    await initializeIdentity(join(dir, 'key'));
    await link(join(dir, 'key'), join(dir, 'link'));
    await assert.rejects(loadIdentity(join(dir, 'key')), { code: 'unsafe_identity_file' });
    await assert.rejects(loadIdentity(join(dir, 'link')), { code: 'unsafe_identity_file' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('identity storage rejects writable parent directories without changing their permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-identity-'));
  try {
    await initializeIdentity(join(dir, 'key'));
    await chmod(dir, 0o777);
    await assert.rejects(loadIdentity(join(dir, 'key')), { code: 'unsafe_identity_directory' });
    await assert.rejects(initializeIdentity(join(dir, 'other-key')), { code: 'unsafe_identity_directory' });
    assert.equal((await stat(dir)).mode & 0o777, 0o777);
  } finally { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); }
});
test('request signature binds domain, identity, operation and payload', () => {
  const identity = makeIdentity();
  const envelope = signRequest(identity, 'PreviewApplication', { application }, operation, { issuedAt: 1793750000, nonce: 'cd'.repeat(16) });
  const { signature, ...unsigned } = envelope;
  const key = createPublicKey({ key: Buffer.from(identity.publicKey, 'base64url'), type: 'spki', format: 'der' });
  const valid = data => verify(null, Buffer.from(canonicalJson(data)), key, Buffer.from(signature, 'base64url'));
  assert.equal(valid({ domain: 'forge-network-v1', ...unsigned }), true);
  assert.equal(valid(unsigned), false);
  assert.equal(valid({ domain: 'forge-network-v1', ...unsigned, operation: 'ef'.repeat(16) }), false);
  assert.equal(valid({ domain: 'forge-network-v1', ...unsigned, params: { application: { ...application, requestedCategory: 'community' } } }), false);
});
test('client uses only fixed HTTPS endpoint and omits credentials and redirects', async () => {
  const normalized = normalizeApplication(application);
  const client = networkClient(makeIdentity(), { fetcher: async (url, options) => {
    assert.equal(url, NETWORK_URL);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Forge-Intake'], '1');
    assert.equal(options.headers['A2A-Version'], '1.0');
    assert.equal(options.headers['A2A-Extensions'], 'https://apeforge.fun/forge-network/v1');
    const rpc = JSON.parse(options.body);
    assert.equal(rpc.jsonrpc, '2.0');
    assert.equal(rpc.method, 'SendMessage');
    assert.equal(rpc.params.message.role, 'ROLE_USER');
    assert.equal(rpc.params.message.messageId, rpc.id);
    const request = JSON.parse(options.body).params.message.parts[0].data.forgeNetwork;
    assert.equal(request.method, 'PreviewApplication');
    assert.deepEqual(request.params.application, normalized);
    return response({ ok: true, application: normalized, previewHash: hash(normalized) }, request.operation);
  } });
  const result = await client.preview(application);
  assert.equal(result.consentRequired, true);
  assert.equal(result.walletVerification, 'unverified');
  assert.equal(result.membershipState, 'not-approved');
});
test('deliberate rotation preserves keys, proves new control and reconciles uncertainty without retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-rotate-'));
  try {
    const oldPath = join(dir, 'old.json'), newPath = join(dir, 'new.json');
    await initializeIdentity(oldPath);
    const oldBytes = await readFile(oldPath, 'utf8');
    const old = await loadIdentity(oldPath);
    let calls = 0;
    const fetcher = async (_, options) => {
      calls++;
      const request = JSON.parse(options.body).params.message.parts[0].data.forgeNetwork;
      assert.equal(request.method, 'RotateIdentity');
      assert.equal(request.operation, operation);
      assert.equal(request.principal, old.principal);
      const newKey = createPublicKey({ key: Buffer.from(request.params.publicKey, 'base64url'), format: 'der', type: 'spki' });
      const proofPayload = { domain: 'forge-network-rotate-v1', oldPrincipal: old.principal, newPublicKey: request.params.publicKey, operation };
      assert.equal(verify(null, Buffer.from(canonicalJson(proofPayload)), newKey, Buffer.from(request.params.newKeyProof, 'base64url')), true);
      assert.equal(verify(null, Buffer.from(canonicalJson({ ...proofPayload, operation: 'ef'.repeat(16) })), newKey, Buffer.from(request.params.newKeyProof, 'base64url')), false);
      throw Error('timeout after possible commit');
    };
    const result = await rotateIdentity(oldPath, newPath, operation, { fetcher });
    assert.equal(result.code, 'network_unconfirmed');
    assert.equal(result.reconcileMethod, 'GetRotationReceipt');
    assert.equal(result.operation, operation);
    assert.equal(result.newPrincipal, (await loadIdentity(newPath)).principal);
    assert.equal(result.privateKey, undefined);
    assert.equal(await readFile(oldPath, 'utf8'), oldBytes);
    await assert.rejects(rotateIdentity(oldPath, newPath, operation, { fetcher }), { code: 'EEXIST' });
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('preview rejects a server hash mismatch without submission', async () => {
  const normalized = normalizeApplication(application);
  const client = networkClient(makeIdentity(), { fetcher: async (_, options) => response({ ok: true, application: normalized, previewHash: '0'.repeat(64) }, JSON.parse(options.body).id) });
  await assert.rejects(client.preview(application), { code: 'invalid_preview' });
});
test('A2A decoder rejects mismatched IDs, wrong context, mixed parts and raw REST successes', async () => {
  const message = { role: 'ROLE_AGENT', messageId: 'reply', contextId: operation, parts: [{ data: { ok: true } }] };
  const malformed = [
    { jsonrpc: '2.0', id: 'wrong', result: { message } },
    { jsonrpc: '2.0', id: operation, result: { message: { ...message, contextId: 'wrong' } } },
    { jsonrpc: '2.0', id: operation, result: { message: { ...message, parts: [{ data: { ok: true }, text: 'ambiguous' }] } } },
    { jsonrpc: '2.0', id: operation, result: { message: { ...message, parts: [...message.parts, ...message.parts] } } },
    { ok: true }
  ];
  for (const value of malformed) {
    const client = networkClient(makeIdentity(), { fetcher: async () => new Response(JSON.stringify(value)) });
    assert.equal((await client.call('ReadInbox', {}, operation)).code, 'network_unconfirmed');
  }
});
test('A2A errors preserve only machine code without echoing arbitrary remote diagnostics', async () => {
  const client = networkClient(makeIdentity(), { fetcher: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: operation, error: { code: -32000, message: 'secret-proxy-detail', data: [{ '@type':'type.googleapis.com/google.rpc.ErrorInfo',domain:'apeforge.fun',reason:'MEMBERSHIP_REQUIRED',metadata:{code:'membership_required',privateDetail:'do-not-output'}}] } }), { status: 403 }) });
  const result = await client.call('ReadInbox', {}, operation);
  assert.equal(result.code, 'membership_required');
  assert.equal(JSON.stringify(result).includes('secret-proxy-detail'), false);
  assert.equal(JSON.stringify(result).includes('do-not-output'), false);
});
test('submit never sends without exact-profile consent, matching hash and durable operation', async () => {
  let calls = 0;
  const client = networkClient(makeIdentity(), { fetcher: async () => { calls++; return response({ ok: true }); } });
  const previewHash = hash(normalizeApplication(application));
  for (const options of [{}, { consent: true, previewHash }, { consent: false, previewHash, operation }, { consent: true, previewHash: '0'.repeat(64), operation }]) {
    await assert.rejects(client.submit(application, options), { code: 'exact_profile_consent_required' });
  }
  assert.equal(calls, 0);
});
test('successful submission sends exact profile and returns only server result, not invented acceptance', async () => {
  const normalized = normalizeApplication(application);
  const client = networkClient(makeIdentity(), { fetcher: async (_, options) => {
    const envelope = JSON.parse(options.body).params.message.parts[0].data.forgeNetwork;
    assert.equal(envelope.method, 'SubmitApplication');
    assert.equal(envelope.operation, operation);
    assert.deepEqual(envelope.params, { application: normalized, previewHash: hash(normalized), consent: true });
    return response({ ok: true, id: 'a111', status: 'applicant', requestedCategory: 'partner' }, envelope.operation);
  } });
  const result = await client.submit(application, { consent: true, previewHash: hash(normalized), operation });
  assert.equal(result.status, 'applicant');
  assert.equal(result.accepted, undefined);
});
test('submission timeout retains operation for signed reconciliation, not duplicate submit', async () => {
  const requests = [];
  const client = networkClient(makeIdentity(), { fetcher: async (_, options) => {
    requests.push(JSON.parse(options.body).params.message.parts[0].data.forgeNetwork);
    if (requests.length === 1) throw new Error('timeout');
    return response({ ok: true, status: 'applicant' }, JSON.parse(options.body).id);
  } });
  const result = await client.submit(application, { consent: true, previewHash: hash(normalizeApplication(application)), operation });
  assert.equal(result.code, 'network_unconfirmed');
  assert.equal(result.operation, operation);
  await client.receipt(result.operation);
  assert.equal(requests[1].method, 'GetApplicationReceipt');
  assert.deepEqual(requests[1].params, { operation });
  assert.notEqual(requests[1].nonce, requests[0].nonce);
});
test('invalid application and reserved URLs never call network', async () => {
  let calls = 0;
  const client = networkClient(makeIdentity(), { fetcher: async () => { calls++; return response({}); } });
  await assert.rejects(client.preview({ ...application, website: 'https://127.0.0.1/' }), { code: 'invalid_application' });
  await assert.rejects(client.preview({ ...application, privateKey: 'do-not-send' }), { code: 'invalid_application' });
  assert.equal(calls, 0);
});
