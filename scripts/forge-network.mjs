#!/usr/bin/env node
/** Native Forge intake. No GitHub, wallet signing, billing, or automatic consent. */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { open, readFile, lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { installListing } from './forge-listing.mjs';
import { validateApplication } from './forge-application-model.mjs';

export const NETWORK_URL = 'https://app.apeforge.fun/api/forge/v1/a2a-v1';
export const NETWORK_EXTENSION = 'https://apeforge.fun/forge-network/v1';
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const error = code => Object.assign(new Error(code), { code });
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  throw error('invalid_canonical_json');
}
export const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function normalizeApplication(application) {
  if (Buffer.byteLength(canonicalJson(application)) > 32768) throw error('application_too_large');
  const result = validateApplication(application);
  if (!result.ok) throw Object.assign(error('invalid_application'), { errors: result.errors });
  return { ...result.application.profile, requestedCategory: result.application.requestedCategory };
}
export function identityFromPrivateKey(privateKey) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw error('invalid_identity');
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url');
  const principal = 'a' + createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 32);
  return { principal, publicKey, privateKey: key.export({ format: 'pem', type: 'pkcs8' }).toString() };
}
async function checkIdentityDirectory(path) {
  const stat = await lstat(dirname(path));
  if (!stat.isDirectory() || (process.platform !== 'win32' && ((stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid())))) throw error('unsafe_identity_directory');
}
export async function initializeIdentity(path) {
  // Exclusive creation prevents silently replacing the applicant's control key.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await checkIdentityDirectory(path);
  const { privateKey } = generateKeyPairSync('ed25519');
  const identity = identityFromPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(identity)); await file.sync(); } finally { await file.close(); }
  return { principal: identity.principal, publicKey: identity.publicKey };
}
export async function loadIdentity(path) {
  await checkIdentityDirectory(path);
  const initial = await lstat(path);
  if (!initial.isFile()) throw error('unsafe_identity_file');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let raw;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || initial.dev !== stat.dev || initial.ino !== stat.ino || (process.platform !== 'win32' && (stat.mode & 0o077))) throw error('unsafe_identity_file');
    raw = await file.readFile('utf8');
  } finally { await file.close(); }
  if (Buffer.byteLength(raw) > 4096) throw error('invalid_identity');
  const stored = JSON.parse(raw);
  const identity = identityFromPrivateKey(stored.privateKey);
  if (stored.principal !== identity.principal || stored.publicKey !== identity.publicKey) throw error('identity_mismatch');
  return identity;
}
export function signRequest(identity, method, params, operation, { issuedAt = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString('hex') } = {}) {
  if (!/^[A-Za-z][A-Za-z0-9]{1,63}$/.test(method) || !HEX32.test(operation) || !HEX32.test(nonce) || !Number.isSafeInteger(issuedAt)) throw error('invalid_request');
  const envelope = { version: 1, method, principal: identity.principal, publicKey: identity.publicKey, issuedAt, nonce, operation, params };
  return { ...envelope, signature: sign(null, Buffer.from(canonicalJson({ domain: 'forge-network-v1', ...envelope })), identity.privateKey).toString('base64url') };
}
export function networkClient(identity, { fetcher = fetch } = {}) {
  async function call(method, params, operation = randomBytes(16).toString('hex')) {
    const envelope = signRequest(identity, method, params, operation);
    let response;
    try {
      const request = { jsonrpc: '2.0', id: operation, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: operation, parts: [{ data: { forgeNetwork: envelope } }] } } };
      response = await fetcher(NETWORK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forge-Intake': '1', 'A2A-Version': '1.0', 'A2A-Extensions': NETWORK_EXTENSION }, body: JSON.stringify(request), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
      let size = 0; const parts = [];
      for await (const part of response.body) { size += part.length; if (size > 65536) throw error('response_too_large'); parts.push(part); }
      const rpc = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!rpc || rpc.jsonrpc !== '2.0' || rpc.id !== operation) throw error('invalid_response');
      if (rpc.error) {
        const details=rpc.error.data;
        if(rpc.result||!Number.isInteger(rpc.error.code)||!Array.isArray(details)||details.length!==1||details[0]?.['@type']!=='type.googleapis.com/google.rpc.ErrorInfo'||details[0].domain!=='apeforge.fun'||!/^[a-z][a-z0-9_]{1,79}$/.test(details[0].metadata?.code))throw error('invalid_response');
        return {ok:false,code:details[0].metadata.code,transportStatus:response.status,operation};
      }
      const message = rpc.result?.message;
      if (!message || message.role !== 'ROLE_AGENT' || typeof message.messageId !== 'string' || message.messageId.length > 128 || message.contextId !== operation || !Array.isArray(message.parts) || message.parts.length !== 1 || !message.parts[0] || Object.keys(message.parts[0]).length !== 1 || !Object.hasOwn(message.parts[0], 'data')) throw error('invalid_response');
      const result = message.parts[0].data;
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw error('invalid_response');
      if (!response.ok && result.ok === true) throw error('invalid_response');
      return { ...result, transportStatus: response.status, operation };
    } catch (cause) {
      // A timeout does not prove submission failed. Keep exactly the original operation.
      return { ok: false, code: 'network_unconfirmed', operation, reconcileMethod: 'GetApplicationReceipt', note: 'Reconcile this operation before retrying submission. No acceptance or wallet verification is established.' };
    }
  }
  return {
    call,
    ...installListing(call, { normalizeApplication, hash, canonicalJson }),
    async preview(application) {
      const normalized = normalizeApplication(application);
      const result = await call('PreviewApplication', { application: normalized });
      if (result.ok !== true) return result;
      if (!result.application || !HEX64.test(result.previewHash) || hash(normalizeApplication(result.application)) !== result.previewHash || canonicalJson(normalizeApplication(result.application)) !== canonicalJson(result.application)) throw error('invalid_preview');
      // Never consent to a server-mutated profile without presenting a new preview.
      return { ...result, consentRequired: true, walletVerification: 'unverified', membershipState: 'not-approved' };
    },
    async submit(application, { consent = false, previewHash, operation } = {}) {
      const normalized = normalizeApplication(application);
      if (consent !== true || !HEX64.test(previewHash) || hash(normalized) !== previewHash || !HEX32.test(operation)) throw error('exact_profile_consent_required');
      return call('SubmitApplication', { application: normalized, previewHash, consent: true }, operation);
    },
    async receipt(operation) {
      if (!HEX32.test(operation)) throw error('invalid_operation');
      return call('GetApplicationReceipt', { operation });
    }
  };
}

export function rotationProof(oldIdentity, newIdentity, operation) {
  if (!HEX32.test(operation) || oldIdentity.principal === newIdentity.principal) throw error('invalid_rotation');
  return sign(null, Buffer.from(canonicalJson({ domain: 'forge-network-rotate-v1', oldPrincipal: oldIdentity.principal, newPublicKey: newIdentity.publicKey, operation })), newIdentity.privateKey).toString('base64url');
}
export async function rotateIdentity(oldPath, newPath, operation, options = {}) {
  if (!HEX32.test(operation) || oldPath === newPath) throw error('invalid_rotation');
  const oldIdentity = await loadIdentity(oldPath);
  // Exclusive creation is deliberate. Never overwrite either control key or retry
  // uncertain rotation by silently generating a different principal.
  await initializeIdentity(newPath);
  const newIdentity = await loadIdentity(newPath);
  const result = await networkClient(oldIdentity, options).call('RotateIdentity', { publicKey: newIdentity.publicKey, newKeyProof: rotationProof(oldIdentity, newIdentity, operation) }, operation);
  return { ...result, ...(result.code === 'network_unconfirmed' ? { reconcileMethod: 'GetRotationReceipt' } : {}), newPrincipal: newIdentity.principal, newPublicKey: newIdentity.publicKey, note: 'Retain both private key files. Reconcile this operation before further rotation. Acceptance and peer consent must be renewed; never infer successful rotation from a timeout.' };
}

async function listingMain(args) {
  const [command, identityPath, applicationPath, revision, visibility, previewHash, operation] = args;
  if (!identityPath) throw error('usage_listing_get_preview_update_receipt');
  const client = networkClient(await loadIdentity(identityPath));
  if (command === 'get' && args.length === 2) return client.getOwnListing();
  if (command === 'receipt' && args.length === 3) return client.listingUpdateReceipt(applicationPath);
  if (!['preview', 'update'].includes(command) || args.length !== (command === 'preview' ? 5 : 7) || !/^[1-9][0-9]{0,15}$/.test(revision)) throw error('usage_listing_get_preview_update_receipt');
  const stat = await lstat(applicationPath);
  if (!stat.isFile() || stat.size > 32768) throw error('application_too_large');
  const application = JSON.parse(await readFile(applicationPath, 'utf8'));
  const options = { expectedRevision: Number(revision), visibility, previewHash, operation, consent: command === 'update' };
  return command === 'preview' ? client.previewListingUpdate(application, options) : client.updateListing(application, options);
}
async function main(args) {
  if (args[0] === 'listing') return listingMain(args.slice(1));
  const [command, identityPath, applicationPath, consentHash, operation] = args;
  if (command === 'init' && identityPath && args.length === 2) return initializeIdentity(identityPath);
  if (command === 'rotate' && args.length === 4) return rotateIdentity(identityPath, applicationPath, consentHash);
  if (!identityPath) throw error('usage_init_preview_submit_receipt');
  const identity = await loadIdentity(identityPath);
  const client = networkClient(identity);
  if (command === 'preview' && applicationPath && args.length === 3) return client.preview(JSON.parse(await readFile(applicationPath, 'utf8')));
  if (command === 'receipt' && applicationPath && args.length === 3) return client.receipt(applicationPath);
  if (command === 'rotate-receipt' && HEX32.test(applicationPath) && args.length === 3) return client.call('GetRotationReceipt', { operation: applicationPath });
  if (command === 'submit' && args.length === 5) return client.submit(JSON.parse(await readFile(applicationPath, 'utf8')), { consent: true, previewHash: consentHash, operation });
  throw error('usage_init_preview_submit_receipt');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(cause => { process.stderr.write(JSON.stringify({ ok: false, code: cause.code || 'local_operation_failed', ...(cause.errors ? { errors: cause.errors } : {}) }) + '\n'); process.exitCode = 1; });
}
