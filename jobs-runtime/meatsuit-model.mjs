export const SKILLS = Object.freeze(['Beginner', 'Intermediate', 'Expert']);
export const CATEGORIES = Object.freeze(['Research', 'Design', 'Development', 'Testing', 'Community', 'Real world', 'Other']);
export const DAY = 86400;
export const REVIEW_SECONDS = 3 * DAY;
const address = /^0x[0-9a-fA-F]{40}$/;
export function rawAmount(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || typeof value !== 'string' || !/^(0|[1-9][0-9]{0,60})(\.[0-9]{1,18})?$/.test(value)) throw Error('Enter a positive decimal APE amount, without commas or exponent notation.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw Error(`APE supports at most ${decimals} decimal places.`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (raw <= 0n || raw > (2n ** 256n - 1n) * 20n / 21n - 1n) throw Error('Reward is outside the supported token amount range.');
  return raw;
}
export function displayAmount(raw, decimals) {
  if (typeof raw !== 'bigint' || raw < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw Error('Invalid token amount.');
  const base = 10n ** BigInt(decimals), fraction = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (raw / base).toString() + (fraction ? '.' + fraction : '');
}
export function quote(value, decimals) {
  const reward = rawAmount(value, decimals), fee = reward / 20n + (reward % 20n ? 1n : 0n);
  return {reward, fee, total: reward + fee};
}
export function safeContact(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && u.hostname.includes('.') && !/[\s\u0000-\u001f]/.test(value); } catch { return false; }
}
export function validateDraft(value) {
  const errors = [], out = {};
  for (const [key, max] of Object.entries({agentId:64,title:120,brief:2000,acceptance:1000,category:32,contact:240})) {
    const text = String(value?.[key] ?? '').trim();
    if (!text || new TextEncoder().encode(text).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) errors.push(`${key}: enter 1–${max} UTF-8 bytes.`);
    out[key] = text;
  }
  if (!safeContact(out.contact)) errors.push('Use a public HTTPS contact link, without credentials or a fragment.');
  if (!CATEGORIES.includes(out.category)) errors.push('Choose a job category.');
  for (const key of ['listingDays', 'deliveryDays']) {
    out[key] = Number(value?.[key]);
    if (!Number.isInteger(out[key]) || out[key] < 1 || out[key] > 30) errors.push(`${key}: choose 1–30 days.`);
  }
  out.skill = Number(value?.skill);
  if (!Number.isInteger(out.skill) || out.skill < 0 || out.skill > 2) errors.push('Choose a skill level.');
  out.reward = String(value?.reward ?? '').trim();
  try { rawAmount(out.reward, 18); } catch(e) { errors.push(e.message); }
  return {ok:errors.length === 0, errors, value:out};
}
export function deploymentReady(config) {
  return config?.version === 1 && config.activationEnabled === true && Number.isSafeInteger(config.chainId) && config.chainId > 0 &&
    Number.isInteger(config.decimals) && config.decimals >= 0 && config.decimals <= 18 &&
    [config.token, config.escrow, config.treasury, config.eligibilityRegistry].every(v => address.test(v || '') && !/^0x0{40}$/i.test(v)) &&
    new Set([config.token, config.escrow, config.treasury, config.eligibilityRegistry].map(v=>v.toLowerCase())).size === 4 &&
    config.autoPayOnTimeout === true && /^0x[a-f0-9]{64}$/i.test(config.runtimeCodeHash || '') && /^0x[a-f0-9]{64}$/i.test(config.eligibilityCodeHash || '');
}
export function stateLabel(job, now) {
  const names = ['Missing','Open','In progress','Awaiting review','Rejected','Paid','Refunded'];
  if (job.state === 1 && now >= job.listingEnds) return 'Listing ended';
  if (job.state === 2 && now >= job.deliveryEnds) return 'Delivery missed';
  if (job.state === 3 && now >= job.reviewEnds) return 'Review ended';
  return names[job.state] ?? 'Unknown';
}
export function filterJobs(jobs,{query='',skill='all',category='all',sort='newest'}={}) {
  const words = query.toLowerCase().trim().slice(0,120).split(/\s+/).filter(Boolean);
  return jobs.filter(j=>(skill==='all'||String(j.skill)===skill)&&(category==='all'||j.terms.category===category)&&words.every(w=>[j.terms.title,j.terms.brief,j.terms.agentId,j.terms.category].join(' ').toLowerCase().includes(w))).sort((a,b)=>sort==='reward'?(a.reward===b.reward?b.id-a.id:a.reward>b.reward?-1:1):b.id-a.id);
}
export function unsignedIntent(action, args, config) {
  if (!deploymentReady(config)) throw Error('APE escrow is not activated. No transaction has been prepared.');
  if (!['post','nominate','accept','submit','approve','reject','refund','settleTimeout'].includes(action)) throw Error('Unsupported escrow action.');
  return {version:1,chainId:config.chainId,to:config.escrow,value:'0',function:action,args};
}
