import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { canonical, keyId, sign, verify, createPeer, makeRequest, verifyResponse } from '../scripts/forge-peer-engine.mjs';

function fixture() {
  let now = Date.parse('2026-11-04T10:00:00Z');
  const clock = () => now;
  function agent(n) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const binding = { agentId: 'g' + n, bindingRevision: 1, keyId: keyId(pub), publicKey: pub, endpoint: `https://peer${n}.example/a2a`, cardUrl: `https://peer${n}.example/card`, expiresAt: new Date(now + 86400000).toISOString(), acceptInbound: true };
    const peer = createPeer({ binding, privateKey, clock });
    binding.sessionId = peer.sessionId;
    return { binding, privateKey, peer };
  }
  const a = agent(1), b = agent(2), c = agent(3);
  const send = (from, to, rpc) => {
    const request = makeRequest(from.binding, from.privateKey, to.binding, rpc, { clock });
    const response = to.peer.dispatch(request);
    return { request, response, json: JSON.parse(response.body) };
  };
  return { a, b, c, send, clock, advance(ms) { now += ms; } };
}
const message = (messageId = 'message-1', text = 'hello') => ({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId, role: 'ROLE_USER', parts: [{ text }] } } });
const get = taskId => ({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: taskId } });

test('canonical Ed25519 signing and exact card control proof', () => {
  const { a } = fixture();
  assert.equal(canonical({ z: [true, { y: 2, a: 1 }], a: null }), '{"a":null,"z":[true,{"a":1,"y":2}]}');
  assert.throws(() => canonical({ bad: undefined }));
  const signature = sign(a.privateKey, { a: 1 });
  assert.equal(verify(a.binding.publicKey, { a: 1 }, signature), true);
  assert.equal(verify(a.binding.publicKey, { a: 2 }, signature), false);
  const proof = a.peer.proof('a'.repeat(32));
  assert.equal(verify(a.binding.publicKey, proof.payload, proof.signature), true);
  assert.equal(proof.payload.sessionId, a.peer.sessionId);
  assert.match(proof.payload.sessionId, /^[a-f0-9]{32}$/);
  assert.equal(Date.parse(proof.payload.expiresAt), Date.parse('2026-11-04T10:01:00Z'));
  assert.equal(proof.payload.cardSha256, createHash('sha256').update(canonical(a.peer.card())).digest('hex'));
  assert.equal(a.peer.card().supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(a.peer.card().capabilities.extensions[0].required, true);
  assert.equal(a.peer.card().security, undefined);
  assert.deepEqual(a.peer.card().securityRequirements, [{ schemes: { forgePeerSignature: { list: [] } } }]);
  const security = a.peer.card().securitySchemes.forgePeerSignature;
  assert.deepEqual(Object.keys(security), ['apiKeySecurityScheme']);
  assert.equal(security.apiKeySecurityScheme.location, 'header');
  assert.equal(security.apiKeySecurityScheme.name, 'X-Forge-Signature');
});

test('proof expiry is fresh and capped by binding expiry; revoked bindings fail closed', () => {
  const { a, b, clock, advance } = fixture();
  const short = { ...a.binding, expiresAt: new Date(clock() + 15000).toISOString() };
  const peer = createPeer({ binding: short, privateKey: a.privateKey, clock });
  assert.equal(peer.proof('f'.repeat(32)).payload.expiresAt, short.expiresAt);
  advance(5000);
  assert.equal(Date.parse(b.peer.proof('e'.repeat(32)).payload.expiresAt), clock() + 60000);
  for (const patch of [{ acceptInbound: false }, { revoked: true }, { revokedAt: '2026-11-04T10:00:00Z' }, { status: 'revoked' }, { expiresAt: 'invalid' }]) {
    assert.throws(() => b.peer.grant({ ...a.binding, ...patch }));
    assert.throws(() => createPeer({ binding: { ...a.binding, ...patch }, privateKey: a.privateKey, clock }));
  }
  advance(10000);
  assert.throws(() => peer.proof('f'.repeat(32)));
});

test('two opted-in peers authenticate, deliver, reply, poll, and revoke', () => {
  const { a, b, send } = fixture();
  assert.equal(send(a, b, message()).response.status, 403);
  a.peer.grant(b.binding); b.peer.grant(a.binding);
  const first = send(a, b, message());
  assert.equal(first.response.status, 200);
  assert.equal(verifyResponse(a.binding, b.binding, first.request, first.response), true);
  const task = first.json.result.task;
  assert.equal(task.status.state, 'TASK_STATE_SUBMITTED');
  assert.equal(send(a, b, message()).json.result.task.id, task.id);
  const retry = message(); retry.id = 77;
  const retried = send(a, b, retry);
  assert.equal(retried.json.id, 77);
  assert.equal(retried.json.result.task.id, task.id);
  assert.equal(send(a, b, message('message-1', 'changed')).response.status, 409);
  b.peer.reply(task.id, 'received');
  const completed = send(a, b, get(task.id));
  assert.equal(completed.json.result.id, task.id);
  assert.equal(completed.json.result.task, undefined);
  assert.equal(completed.json.result.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(completed.json.result.history[1].role, 'ROLE_AGENT');
  assert.equal(completed.json.result.history[1].parts[0].text, 'received');
  const replyTask = send(b, a, message('reverse', 'reply over reverse direction')).json.result.task;
  a.peer.reply(replyTask.id, 'acknowledged');
  assert.equal(send(b, a, get(replyTask.id)).json.result.status.state, 'TASK_STATE_COMPLETED');
  b.peer.revoke(a.binding.agentId);
  assert.equal(send(a, b, get(task.id)).response.status, 403);
  assert.throws(() => b.peer.reply(task.id, 'not allowed'));
  b.peer.grant(a.binding);
  assert.equal(send(a, b, get(task.id)).response.status, 404);
});

test('signature spoofing, replay, wrong recipient and changed body fail', () => {
  const { a, b, c, clock } = fixture(); b.peer.grant(a.binding); c.peer.grant(a.binding);
  const req = makeRequest(a.binding, a.privateKey, b.binding, message(), { clock });
  assert.equal(b.peer.dispatch({ ...req, body: req.body + ' ' }).status, 401);
  assert.equal(c.peer.dispatch(req).status, 401);
  const spoof = { ...req, headers: { ...req.headers, 'x-forge-signature': sign(c.privateKey, { forged: true }) } };
  assert.equal(b.peer.dispatch(spoof).status, 401);
  assert.equal(b.peer.dispatch(req).status, 200);
  const replay = b.peer.dispatch(req);
  assert.equal(replay.status, 409);
  assert.equal(verifyResponse(a.binding, b.binding, req, replay), true);
  const tampered = { ...replay, body: replay.body + ' ' };
  assert.equal(verifyResponse(a.binding, b.binding, req, tampered), false);
});

test('time, protocol and session fencing include process restart', () => {
  const { a, b, clock, advance } = fixture(); b.peer.grant(a.binding);
  const req = makeRequest(a.binding, a.privateKey, b.binding, message(), { clock });
  const fresh = createPeer({ binding: b.binding, privateKey: b.privateKey, clock }); fresh.grant(a.binding);
  assert.equal(fresh.dispatch(req).status, 401);
  const versionError=b.peer.dispatch({ ...req, headers: { ...req.headers, 'a2a-version': '0.3.0' } });
  assert.equal(versionError.status,400);assert.equal(JSON.parse(versionError.body).id,JSON.parse(req.body).id);
  assert.equal(b.peer.dispatch((()=>{const fresh=makeRequest(a.binding,a.privateKey,b.binding,message(),{clock});return{...fresh,headers:{...fresh.headers,'a2a-extensions':''}};})()).status, 400);
  advance(61001);
  assert.equal(b.peer.dispatch(req).status, 401);
});

test('tasks and contexts are isolated; payloads are bounded data only', () => {
  const { a, b, c, send } = fixture(); b.peer.grant(a.binding); b.peer.grant(c.binding);
  const task = send(a, b, message()).json.result.task;
  const missing = send(c, b, get('missing'));
  const foreign = send(c, b, get(task.id));
  assert.deepEqual(foreign.json.error, missing.json.error);
  const foreignContext = message('foreign'); foreignContext.params.message.contextId = task.contextId;
  assert.equal(send(c, b, foreignContext).response.status, 404);
  const validContext = message('same-context'); validContext.params.message.contextId = task.contextId;
  assert.equal(send(a, b, validContext).response.status, 200);
  const extra = message('tools'); extra.params.message.metadata = { execute: 'anything' };
  assert.equal(send(a, b, extra).response.status, 400);
  assert.equal(send(a, b, message('oversize', 'x'.repeat(4097))).response.status, 400);
  assert.equal(b.peer.dispatch({ body: 'x'.repeat(16385), headers: { 'x-forge-peer': a.binding.agentId, 'x-forge-key': a.binding.keyId } }).status, 413);
  assert.equal(send(a, b, { jsonrpc: '2.0', id: 1, method: 'StreamMessage', params: {} }).response.status, 404);
});

test('rate limits, finite retention and one-hour consent expiry', () => {
  const { a, b, send, advance } = fixture(); b.peer.grant(a.binding);
  const task = send(a, b, message()).json.result.task;
  for (let i = 1; i < 30; i++) assert.equal(send(a, b, get(task.id)).response.status, 200);
  assert.equal(send(a, b, get(task.id)).response.status, 429);
  advance(60000); assert.equal(send(a, b, get(task.id)).response.status, 200);
  advance(3540001); assert.equal(send(a, b, get(task.id)).response.status, 403);
  b.peer.grant(a.binding); assert.equal(send(a, b, get(task.id)).response.status, 404);
});

test('key rotation destroys old conversation scope and old key access', () => {
  const { a, b, c, send } = fixture(); b.peer.grant(a.binding);
  const task = send(a, b, message()).json.result.task;
  const rotated = { ...c.binding, agentId: a.binding.agentId, bindingRevision: 2 };
  b.peer.grant(rotated);
  assert.equal(send(a, b, get(task.id)).response.status, 403);
  assert.throws(() => b.peer.grant(a.binding));
});

test('explicit grant refresh tolerates a new proved sender process session, not identity mutation', () => {
 const {a,b}=fixture();b.peer.grant(a.binding);
 assert.doesNotThrow(()=>b.peer.grant({...a.binding,sessionId:'f'.repeat(32)}));
 assert.throws(()=>b.peer.grant({...a.binding,endpoint:'https://changed.apeforge.fun/a2a'}));
});
