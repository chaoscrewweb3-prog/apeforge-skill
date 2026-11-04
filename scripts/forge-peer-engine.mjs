import { createHash, createPublicKey, randomBytes, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

const VERSION = '1.0';
const EXTENSION = 'https://apeforge.fun/forge-peer/v1';
const MAX_BODY = 16 * 1024;
const MAX_TEXT = 4 * 1024;
const RETENTION = 3600000;
const hash = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const own = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k));

/** Canonical, recursively key-sorted JSON. Only JSON data is accepted. */
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new TypeError('Only finite JSON data is supported');
}
function publicObject(publicKey) {
  if (typeof publicKey !== 'string' || publicKey.length > 256 || !/^[A-Za-z0-9_-]+$/.test(publicKey)) throw new TypeError('Expected base64url SPKI public key');
  const der = Buffer.from(publicKey, 'base64url');
  if (der.toString('base64url') !== publicKey) throw new TypeError('Noncanonical public key');
  const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Ed25519 is required');
  return key;
}
export function keyId(publicKey) { publicObject(publicKey); return hash(Buffer.from(publicKey, 'base64url')); }
export function sign(privateKey, value) { return cryptoSign(null, Buffer.from(canonical(value)), privateKey).toString('base64url'); }
export function verify(publicKey, value, signature) {
  try {
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    return cryptoVerify(null, Buffer.from(canonical(value)), publicObject(publicKey), Buffer.from(signature, 'base64url'));
  } catch { return false; }
}
function validBinding(binding, now) {
  if (!binding || !id(binding.agentId) || !/^g[0-9]+$/.test(binding.agentId) || binding.revoked === true || binding.revokedAt != null || binding.status === 'revoked' || !Number.isSafeInteger(binding.bindingRevision) || binding.bindingRevision < 1 || binding.acceptInbound !== true || keyId(binding.publicKey) !== binding.keyId || !Number.isFinite(Date.parse(binding.expiresAt)) || Date.parse(binding.expiresAt) <= now) throw new TypeError('Invalid or expired consent binding');
  for (const field of ['endpoint', 'cardUrl']) {
    if (typeof binding[field] !== 'string' || binding[field].length > 2048) throw new TypeError('Bounded HTTPS binding URLs required');
    const url = new URL(binding[field]);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new TypeError('HTTPS binding URLs required');
  }
  return copy(binding);
}
function requestPayload(from, to, headers, body) {
  return { domain: 'forge-peer-request-v1', method: 'POST', url: to.endpoint, from: from.agentId, to: to.agentId, keyId: from.keyId, issuedAt: headers['x-forge-time'], nonce: headers['x-forge-nonce'], bodySha256: hash(body), protocolVersion: VERSION, recipientSession: headers['x-forge-session'] };
}
export function makeRequest(senderBinding, privateKey, recipientBinding, rpc, { clock = Date.now } = {}) {
  const now = clock();
  const from = validBinding(senderBinding, now), to = validBinding(recipientBinding, now);
  if (typeof to.sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(to.sessionId)) throw new TypeError('Verified recipient session is required');
  const body = canonical(rpc);
  const headers = { 'content-type': 'application/json', 'a2a-version': VERSION, 'a2a-extensions': EXTENSION, 'x-forge-session': to.sessionId, 'x-forge-peer': from.agentId, 'x-forge-key': from.keyId, 'x-forge-time': String(Math.floor(now / 1000)), 'x-forge-nonce': randomBytes(16).toString('hex') };
  headers['x-forge-signature'] = sign(privateKey, requestPayload(from, to, headers, body));
  return { body, headers };
}
export function verifyResponse(senderBinding, recipientBinding, request, response) {
  return response?.headers?.['x-forge-peer'] === recipientBinding.agentId && response.headers['x-forge-key'] === recipientBinding.keyId && typeof response.body === 'string' && verify(recipientBinding.publicKey, { domain: 'forge-peer-response-v1', from: recipientBinding.agentId, to: senderBinding.agentId, requestNonce: request.headers['x-forge-nonce'], bodySha256: hash(response.body) }, response.headers['x-forge-signature']);
}

/** Memory-only recipient. No network, filesystem, model, shell, or tool execution. */
export function createPeer({ binding, privateKey, clock = Date.now }) {
  const local = validBinding(binding, clock());
  if (!verify(local.publicKey, { check: true }, sign(privateKey, { check: true }))) throw new TypeError('Private key does not match binding');
  const sessionId = randomBytes(16).toString('hex');
  const peers = new Map(), tasks = new Map(), nonces = new Map(), rates = new Map();
  let generation = 0;
  const nowISO = () => new Date(clock()).toISOString();
  function purge() {
    const now = clock();
    for (const [k, t] of tasks) if (now - t.created >= RETENTION) tasks.delete(k);
    for (const [k, expiry] of nonces) if (expiry <= now) nonces.delete(k);
    for (const [k, r] of rates) if (now - r.start >= 60000) rates.delete(k);
  }
  function removeTasks(agentId) { for (const [k, t] of tasks) if (t.agentId === agentId) tasks.delete(k); }
  function grant(peerBinding) {
    purge();
    const peer = validBinding(peerBinding, clock());
    if (peer.agentId === local.agentId || (!peers.has(peer.agentId) && peers.size >= 128)) throw new TypeError('Peer grant unavailable');
    const old = peers.get(peer.agentId);
    const stable = value => { const { sessionId: _session, ...identity } = value; return canonical(identity); };
    if (old && stable(old.binding) === stable(peer)) { old.binding = peer; old.expires = Math.min(Date.parse(peer.expiresAt), clock() + RETENTION); return; }
    if (old && peer.bindingRevision <= old.binding.bindingRevision) throw new TypeError('Binding revision must increase');
    removeTasks(peer.agentId);
    peers.set(peer.agentId, { binding: peer, generation: ++generation, expires: Math.min(Date.parse(peer.expiresAt), clock() + RETENTION) });
  }
  function revoke(agentId) { peers.delete(agentId); removeTasks(agentId); generation++; }
  function response(status, payload, authenticated, requestNonce) {
    const body = canonical(payload);
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'a2a-version': VERSION };
    if (authenticated) {
      headers['x-forge-peer'] = local.agentId;
      headers['x-forge-key'] = local.keyId;
      headers['x-forge-signature'] = sign(privateKey, { domain: 'forge-peer-response-v1', from: local.agentId, to: authenticated.agentId, requestNonce, bodySha256: hash(body) });
    }
    return { status, body, headers };
  }
  function dispatch({ body, headers } = {}) {
    purge();
    let authenticated, nonce, rpcId = null;
    const fail = (status, reason, code = -32602) => response(status, { jsonrpc: '2.0', id: rpcId, error: { code, message: reason, data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: reason.toUpperCase(), domain: 'apeforge.fun' }] } }, authenticated, nonce);
    // Unknown identities get the same denial before body parsing or version details.
    const grantRecord = peers.get(headers?.['x-forge-peer']);
    if (!grantRecord || grantRecord.binding.keyId !== headers?.['x-forge-key'] || grantRecord.expires <= clock() || Date.parse(local.expiresAt) <= clock()) return fail(403, 'peer_not_authorized', -32099);
    const remote = grantRecord.binding;
    if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY) return fail(413, 'body_limit');
    const issuedAt = headers['x-forge-time']; nonce = headers['x-forge-nonce'];
    if (headers['x-forge-session'] !== sessionId || !/^[0-9]{1,12}$/.test(issuedAt || '') || !/^[a-f0-9]{32}$/.test(nonce || '') || Math.abs(clock() - Number(issuedAt) * 1000) > 60000 || !verify(remote.publicKey, requestPayload(remote, local, headers, body), headers['x-forge-signature'])) return fail(401, 'authentication_failed', -32099);
    authenticated = remote;
    const nonceKey = remote.agentId + ':' + remote.keyId + ':' + nonce;
    if (nonces.has(nonceKey)) return fail(409, 'replay_rejected', -32099);
    if (nonces.size >= 20000) return fail(429, 'capacity_limit', -32099);
    nonces.set(nonceKey, clock() + 300000);
    const rateKey = remote.agentId + ':' + remote.keyId;
    let rate = rates.get(rateKey);
    if (!rate) { rate = { start: clock(), count: 0 }; rates.set(rateKey, rate); }
    if (++rate.count > 30) return fail(429, 'rate_limit', -32099);
    let rpc;
    try { rpc = JSON.parse(body); } catch { return fail(400, 'invalid_json', -32700); }
    if (!own(rpc, ['jsonrpc', 'id', 'method', 'params']) || rpc.jsonrpc !== '2.0' || !(id(rpc.id) || Number.isSafeInteger(rpc.id)) || typeof rpc.method !== 'string') return fail(400, 'invalid_request', -32600);
    rpcId = rpc.id;
    if (headers['a2a-version'] !== VERSION) return fail(400, 'version_not_supported', -32009);
    if (headers['a2a-extensions'] !== EXTENSION) return fail(400, 'required_extension_missing', -32602);
    const scope = remote.agentId + ':' + remote.keyId + ':' + grantRecord.generation;
    const matching = t => t.scope === scope;
    if (rpc.method === 'SendMessage') {
      const params = rpc.params, m = params?.message;
      if (!own(params, ['message']) || !own(m, ['messageId', 'role', 'parts', 'contextId']) || !id(m.messageId) || m.role !== 'ROLE_USER' || !Array.isArray(m.parts) || m.parts.length !== 1 || !own(m.parts[0], ['text']) || typeof m.parts[0].text !== 'string' || !m.parts[0].text.trim() || Buffer.byteLength(m.parts[0].text) > MAX_TEXT || (m.contextId !== undefined && !id(m.contextId))) return fail(400, 'invalid_message');
      for (const t of tasks.values()) if (matching(t) && t.messageId === m.messageId) return t.bodyHash === hash(canonical(m)) ? response(200, { jsonrpc: '2.0', id: rpcId, result: { task: copy(t.task) } }, remote, nonce) : fail(409, 'message_id_conflict', -32099);
      if (m.contextId !== undefined && ![...tasks.values()].some(t => matching(t) && t.task.contextId === m.contextId)) return fail(404, 'resource_unavailable', -32001);
      if (tasks.size >= 128) return fail(429, 'capacity_limit', -32099);
      const taskId = randomBytes(16).toString('hex');
      const task = { id: taskId, contextId: m.contextId ?? randomBytes(16).toString('hex'), status: { state: 'TASK_STATE_SUBMITTED', timestamp: nowISO() }, history: [copy(m)] };
      tasks.set(taskId, { scope, agentId: remote.agentId, created: clock(), messageId: m.messageId, bodyHash: hash(canonical(m)), task });
      return response(200, { jsonrpc: '2.0', id: rpcId, result: { task: copy(task) } }, remote, nonce);
    }
    if (rpc.method === 'GetTask') {
      const p = rpc.params;
      if (!own(p, ['id', 'historyLength']) || !id(p.id) || (p.historyLength !== undefined && (!Number.isInteger(p.historyLength) || p.historyLength < 0 || p.historyLength > 8))) return fail(400, 'invalid_task_request');
      const t = tasks.get(p.id);
      if (!t || !matching(t)) return fail(404, 'resource_unavailable', -32001);
      const task = copy(t.task);
      if (p.historyLength !== undefined) task.history = p.historyLength === 0 ? [] : task.history.slice(-p.historyLength);
      return response(200, { jsonrpc: '2.0', id: rpcId, result: task }, remote, nonce);
    }
    return fail(404, 'method_not_supported', -32601);
  }
  function reply(taskId, text) {
    purge();
    const t = tasks.get(taskId), p = t && peers.get(t.agentId);
    if (!t || !p || Date.parse(local.expiresAt) <= clock() || p.expires <= clock() || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_TEXT || t.task.status.state !== 'TASK_STATE_SUBMITTED') throw new Error('Reply unavailable');
    t.task.history.push({ messageId: randomBytes(16).toString('hex'), role: 'ROLE_AGENT', parts: [{ text }], contextId: t.task.contextId });
    t.task.status = { state: 'TASK_STATE_COMPLETED', timestamp: nowISO() };
    return copy(t.task);
  }
  function proof(nonce) {
    if (!/^[a-f0-9]{32}$/.test(nonce) || Date.parse(local.expiresAt) <= clock()) throw new TypeError('Invalid proof challenge or expired binding');
    const payload = { domain: 'forge-peer-proof-v1', agentId: local.agentId, keyId: local.keyId, cardUrl: local.cardUrl, endpoint: local.endpoint, bindingRevision: local.bindingRevision, nonce, expiresAt: new Date(Math.min(Date.parse(local.expiresAt), clock() + 60000)).toISOString(), sessionId, cardSha256: hash(canonical(card())) };
    return { payload, signature: sign(privateKey, payload) };
  }
  function card() {
    return { name: local.agentId, description: 'Opt-in direct peer messaging reference recipient. Not a Forge relay or paid data service.', version: '1.0.0', supportedInterfaces: [{ url: local.endpoint, protocolBinding: 'JSONRPC', protocolVersion: VERSION }], capabilities: { streaming: false, pushNotifications: false, extensions: [{ uri: EXTENSION, required: true, description: 'Ed25519 signed requests and responses, explicit per-peer recipient grants; no anonymous messaging.', params: { sessionId, agentId: local.agentId, keyId: local.keyId, publicKey: local.publicKey, bindingRevision: local.bindingRevision, expiresAt: local.expiresAt, authentication: 'X-Forge-Peer, X-Forge-Key, X-Forge-Time, X-Forge-Nonce, X-Forge-Session, X-Forge-Signature; A2A-Extensions required; forge-peer-request-v1 canonical signature' } }] }, securitySchemes: { forgePeerSignature: { apiKeySecurityScheme: { location: 'header', name: 'X-Forge-Signature', description: 'Per-request Ed25519 proof, not a reusable API key. The required forge-peer/v1 extension defines all signed headers and recipient consent.' } } }, securityRequirements: [{ schemes: { forgePeerSignature: { list: [] } } }], defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 'direct-peer-message', name: 'Bounded consented peer message', description: 'SendMessage, owner-local reply and GetTask only. No tools, billing or registration.', tags: ['messaging'] }] };
  }
  return Object.freeze({ sessionId, grant, revoke, dispatch, reply, proof, card });
}
