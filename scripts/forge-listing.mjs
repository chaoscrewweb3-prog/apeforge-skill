/** Own native listing replacement. Dependencies injected to keep one canonical implementation. */
export const LISTING_CONSENT = 'I consent to publishing this exact updated public profile, services and listing visibility. This does not change membership, network permissions or payment authorization.';
const fail = code => Object.assign(new Error(code), { code });
const operationValid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validRevision = value => Number.isSafeInteger(value) && value > 0;
const validVisibility = value => ['listed', 'unlisted'].includes(value);
const validNetworkStatus = value => ['pending', 'accepted', 'revoked'].includes(value);
export function installListing(call, { normalizeApplication, hash, canonicalJson }) {
  const previewHashFor = (agentId, application, expectedRevision, visibility) => hash({ domain: 'forge-listing-update-v1', agentId, expectedRevision, visibility, application });
  function checkOwn(result) {
    if (result.ok !== true) return result;
    if (!/^g[0-9]{1,16}$/.test(result.id) || !validRevision(result.revision) || !validVisibility(result.visibility) || !validNetworkStatus(result.networkStatus) || canonicalJson(normalizeApplication(result.application)) !== canonicalJson(result.application)) throw fail('invalid_own_listing');
    return result;
  }
  function validReceipt(result, ownId, { expectedRevision, visibility } = {}) {
    return result.ok === true && result.id === ownId && validRevision(result.revision) && (expectedRevision === undefined || result.revision === expectedRevision + 1) && validVisibility(result.visibility) && (visibility === undefined || result.visibility === visibility) && result.updated === true && validNetworkStatus(result.networkStatus) && result.agentUrl === `https://app.apeforge.fun/app/forge-agent.html?id=${ownId}` && /^https:\/\/app\.apeforge\.fun\/app\/forge-project\.html\?id=p[a-f0-9]{24}$/.test(result.projectUrl) && result.sourceUrl === `https://app.apeforge.fun/api/forge/v1/applications/${ownId}`;
  }
  function invalidReceipt(operation) {
    return { ok: false, code: 'invalid_listing_update_receipt', operation, listingOperation: operation, reconcileMethod: 'GetListingUpdateReceipt', note: 'The listing update may have completed but its response was not valid. Reconcile this original operation. Never generate a new operation blindly.' };
  }
  async function getOwnListing() { return checkOwn(await call('GetOwnListing', {})); }
  async function prepare(application, expectedRevision, visibility) {
    if (!validRevision(expectedRevision) || !validVisibility(visibility)) throw fail('invalid_listing_update');
    const normalized = normalizeApplication(application);
    const own = await getOwnListing();
    if (own.ok !== true) return { failure: own };
    if (normalized.ownerWallet !== own.application.ownerWallet || normalized.requestedCategory !== own.application.requestedCategory) throw fail('immutable_listing_field');
    return { normalized, own, previewHash: previewHashFor(own.id, normalized, expectedRevision, visibility) };
  }
  async function previewListingUpdate(application, { expectedRevision, visibility } = {}) {
    const state = await prepare(application, expectedRevision, visibility);
    if (state.failure) return state.failure;
    if (state.own.revision !== expectedRevision) return { ok: false, code: 'revision_conflict', revision: state.own.revision, note: 'Read your own listing, merge deliberately, preview again and obtain fresh consent. Never blindly retry.' };
    const result = await call('PreviewListingUpdate', { application: state.normalized, expectedRevision, visibility });
    if (result.ok !== true) return result;
    if (result.id !== state.own.id || result.expectedRevision !== expectedRevision || result.visibility !== visibility || !hashValid(result.previewHash) || result.previewHash !== state.previewHash || canonicalJson(result.application) !== canonicalJson(state.normalized) || canonicalJson(normalizeApplication(result.application)) !== canonicalJson(result.application) || result.consentStatement !== LISTING_CONSENT || typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now() || Date.parse(result.expiresAt) > Date.now() + 86400000 + 60000) throw fail('invalid_listing_preview');
    return { ...result, consentRequired: true };
  }
  async function updateListing(application, { expectedRevision, visibility, previewHash, operation, consent = false } = {}) {
    // Check consent before reading or transmitting any update data.
    if (consent !== true || !operationValid(operation) || !hashValid(previewHash)) throw fail('exact_listing_consent_required');
    const state = await prepare(application, expectedRevision, visibility);
    if (state.failure) return state.failure;
    if (previewHash !== state.previewHash) throw fail('exact_listing_consent_required');
    const result = await call('UpdateListing', { application: state.normalized, expectedRevision, visibility, previewHash, consent: true }, operation);
    if (result.code === 'network_unconfirmed') return { ...result, reconcileMethod: 'GetListingUpdateReceipt', note: 'Save the original operation and exact parameters. Query its listing update receipt before any retry. Never generate a new operation blindly.' };
    return result.ok === true && !validReceipt(result, state.own.id, { expectedRevision, visibility }) ? invalidReceipt(operation) : result;
  }
  async function listingUpdateReceipt(operation) {
    if (!operationValid(operation)) throw fail('invalid_operation');
    const own = await getOwnListing();
    if (own.ok !== true) return { ...own, listingOperation: operation, reconcileMethod: 'GetListingUpdateReceipt' };
    const result = await call('GetListingUpdateReceipt', { operation });
    if (result.code === 'network_unconfirmed') return { ...result, reconcileMethod: 'GetListingUpdateReceipt', listingOperation: operation };
    return result.ok === true && !validReceipt(result, own.id) ? invalidReceipt(operation) : result;
  }
  return { getOwnListing, previewListingUpdate, updateListing, listingUpdateReceipt };
}
