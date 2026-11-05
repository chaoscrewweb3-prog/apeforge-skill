/** Applicant-owned avatar upload. Pinning never implies consent to a listing update. */
import { createHash } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
export const AVATAR_MAX_BYTES = 1048576;
export const AVATAR_MEDIA_TYPES = Object.freeze(['image/png','image/jpeg','image/gif']);
const fail = code => Object.assign(new Error(code), { code });
const operationValid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const revisionValid = value => Number.isSafeInteger(value) && value > 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, value = 0, result = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; } }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
// CIDv1, raw codec (0x55), sha2-256 multihash (0x12, 0x20).
export function avatarUriForHash(digest) {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw fail('invalid_avatar_hash');
  return 'ipfs://b' + base32(Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), Buffer.from(digest, 'hex')]));
}
export function avatarBytes(bytesBase64, mediaType) {
  if (!AVATAR_MEDIA_TYPES.includes(mediaType) || typeof bytesBase64 !== 'string' || bytesBase64.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytesBase64)) throw fail('invalid_avatar_upload');
  const bytes = Buffer.from(bytesBase64, 'base64');
  if (!bytes.length || bytes.length > AVATAR_MAX_BYTES || bytes.toString('base64') !== bytesBase64) throw fail('invalid_avatar_upload');
  // Early signature screening only. The backend must also validate raster signatures and structure; compressed pixels are not fully decoded.
  const png = bytes.length >= 33 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && bytes.toString('ascii',12,16) === 'IHDR';
  const gif = bytes.length>=14 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6));
  const jpg = bytes.length>=16 && bytes[0]===255 && bytes[1]===216 && bytes[bytes.length-2]===255 && bytes[bytes.length-1]===217;
  if(mediaType==='image/gif'){if(!gif||!bytes.readUInt16LE(6)||!bytes.readUInt16LE(8)||bytes.readUInt16LE(6)>2048||bytes.readUInt16LE(8)>2048||bytes.readUInt16LE(6)*bytes.readUInt16LE(8)>1048576)throw fail('avatar_type_mismatch');return bytes;}
  if(mediaType==='image/jpeg'){if(!jpg)throw fail('avatar_type_mismatch');return bytes;}
  if (!png || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(16) > 2048 || bytes.readUInt32BE(20) > 2048 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 1048576 || bytes[28] !== 0) throw fail('avatar_type_mismatch');
  return bytes;
}
export async function readAvatarFile(path, mediaType) {
  const initial = await lstat(path);
  if (!initial.isFile() || initial.size < 1 || initial.size > AVATAR_MAX_BYTES) throw fail('invalid_avatar_file');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== initial.dev || stat.ino !== initial.ino || stat.size < 1 || stat.size > AVATAR_MAX_BYTES) throw fail('invalid_avatar_file');
    // Fixed-size read avoids unbounded allocation if another process grows the file.
    const bytes = Buffer.alloc(AVATAR_MAX_BYTES + 1); let size = 0;
    while (size < bytes.length) { const r = await file.read(bytes, size, bytes.length - size, null); if (!r.bytesRead) break; size += r.bytesRead; }
    const bytesBase64 = bytes.subarray(0,size).toString('base64'); avatarBytes(bytesBase64, mediaType);
    return { bytesBase64, mediaType };
  } finally { await file.close(); }
}
export function serverAvatarUri(digest,type){if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||!AVATAR_MEDIA_TYPES.includes(type))throw fail('invalid_avatar_hash');return 'https://app.apeforge.fun/api/forge/v1/media/'+digest+'.'+({'image/png':'png','image/jpeg':'jpg','image/gif':'gif'}[type]);}
function receiptValid(result) {
  return result?.ok === true && /^g[0-9]{1,16}$/.test(result.id) && revisionValid(result.expectedRevision) && AVATAR_MEDIA_TYPES.includes(result.mediaType) && Number.isInteger(result.size) && result.size > 0 && result.size <= AVATAR_MAX_BYTES && result.verified === true && result.retrieval === 'healthy' && ((result.storage==='server' && result.storageStatus==='healthy' && result.uri===serverAvatarUri(result.sha256,result.mediaType)) || (!result.storage && result.pinning==='healthy' && result.uri===avatarUriForHash(result.sha256)));
}
export function installAvatar(call, { getOwnListing, previewListingUpdate }) {
  async function getAvatarUploadStatus() {
    const own = await getOwnListing(); if (own.ok !== true) return own;
    const result = await call('GetAvatarUploadStatus', {}); if (result.ok !== true) return result;
    const health = value => ['unconfigured','unknown','healthy','unhealthy'].includes(value);
    if(result.storage==='server'){if(result.id!==own.id||result.storageStatus!=='ready'||!['healthy','unknown','unhealthy'].includes(result.retrieval)||result.available!==true||result.public!==true||result.maxBytes!==AVATAR_MAX_BYTES||JSON.stringify(result.mediaTypes)!==JSON.stringify(AVATAR_MEDIA_TYPES)||!(result.checkedAt===null||Number.isFinite(Date.parse(result.checkedAt))))throw fail('invalid_avatar_status');return result;}
    if (result.id !== own.id || !health(result.pinning) || !health(result.retrieval) || !(result.checkedAt === null || (typeof result.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(result.checkedAt) && Number.isFinite(Date.parse(result.checkedAt)))) || result.maxBytes !== AVATAR_MAX_BYTES || JSON.stringify(result.mediaTypes) !== JSON.stringify(AVATAR_MEDIA_TYPES) || typeof result.available !== 'boolean' || (!result.available && result.pinning !== 'unconfigured')) throw fail('invalid_avatar_status');
    return result;
  }
  async function uploadAvatar({ bytesBase64, mediaType, expectedRevision, operation } = {}) {
    if (!operationValid(operation) || !revisionValid(expectedRevision)) throw fail('invalid_avatar_upload');
    const bytes = avatarBytes(bytesBase64, mediaType), digest = sha256(bytes);
    const own = await getOwnListing(); if (own.ok !== true) return own;
    if (own.revision !== expectedRevision) return { ok: false, code: 'revision_conflict', revision: own.revision };
    const result = await call('UploadAvatar', { mediaType, bytesBase64, sha256: digest, expectedRevision }, operation);
    if (result.ok !== true) { const { reconcileMethod, uri, verified, ...failure } = result; return { ...failure, ...(result.code === 'network_unconfirmed' ? { reconcileMethod: 'GetAvatarUploadReceipt' } : {}), note: 'No listing update was sent. Retain the current/default avatar. An uncertain upload does not authorize automatic retry or listing update.' }; }
    if (!receiptValid(result) || result.id !== own.id || result.expectedRevision !== expectedRevision || result.sha256 !== digest || result.size !== bytes.length || result.mediaType !== mediaType) throw fail('invalid_avatar_upload_receipt');
    return { ...result, avatarOperation: operation, listingUpdated: false, consentRequired: true };
  }
  async function avatarUploadReceipt(operation) {
    if (!operationValid(operation)) throw fail('invalid_operation');
    const own = await getOwnListing(); if (own.ok !== true) return own;
    const result = await call('GetAvatarUploadReceipt', { operation });
    if (result.ok !== true) { const { uri, verified, ...failure } = result; return { ...failure, reconcileMethod: 'GetAvatarUploadReceipt', avatarOperation: operation }; }
    if (!receiptValid(result) || result.id !== own.id) throw fail('invalid_avatar_upload_receipt');
    return { ...result, avatarOperation: operation, listingUpdated: false, consentRequired: true };
  }
  async function previewAvatarUpdate(receipt) {
    if (!receiptValid(receipt) || !operationValid(receipt.avatarOperation)) throw fail('invalid_avatar_upload_receipt');
    // A caller-supplied verified flag is not evidence. Re-read the durable upload
    // receipt through the authenticated service before preparing any preview.
    const confirmed = await avatarUploadReceipt(receipt.avatarOperation);
    if (confirmed.ok !== true) return confirmed;
    for (const key of ['id', 'expectedRevision', 'uri', 'sha256', 'mediaType', 'size']) {
      if (confirmed[key] !== receipt[key]) throw fail('avatar_upload_receipt_mismatch');
    }
    const own = await getOwnListing(); if (own.ok !== true) return own;
    if (confirmed.id !== own.id) throw fail('avatar_owner_mismatch');
    if (own.revision !== confirmed.expectedRevision) return { ok: false, code: 'revision_conflict', revision: own.revision };
    return previewListingUpdate({ ...own.application, avatar: confirmed.uri }, { expectedRevision: own.revision, visibility: own.visibility });
  }
  return { getAvatarUploadStatus, uploadAvatar, avatarUploadReceipt, previewAvatarUpdate };
}
