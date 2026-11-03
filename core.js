export class ShareError extends Error {
  constructor(code) { super(code); this.name = 'ShareError'; this.code = code; }
}

export function positiveId(value) {
  const text = String(value ?? '');
  if (!/^[1-9]\d{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new ShareError('INVALID_ID');
  }
  return text;
}

export function parseMediaReference(reference) {
  if (typeof reference !== 'string') throw new ShareError('INVALID_MEDIA');
  const match = /^(video|clip)(-?[1-9]\d{0,15})_([1-9]\d{0,15})$/.exec(reference);
  if (!match) throw new ShareError('INVALID_MEDIA');
  positiveId(match[2].replace(/^-/, ''));
  positiveId(match[3]);
  return { kind: match[1], attachment: `video${match[2]}_${match[3]}` };
}

export function selectCampaign(hash, campaigns, fallback) {
  if (typeof hash !== 'string' || hash.length > 200) throw new ShareError('INVALID_LINK');
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if ([...params.keys()].some((key) => key !== 'post') || params.getAll('post').length > 1) {
    throw new ShareError('INVALID_LINK');
  }
  const key = params.has('post') ? params.get('post') : fallback;
  if (!Object.hasOwn(campaigns, key)) throw new ShareError('UNKNOWN_CAMPAIGN');
  const campaign = campaigns[key];
  const media = parseMediaReference(campaign.mediaReference);
  const source = new URL(campaign.sourceUrl);
  if (source.origin !== 'https://vk.ru' || !/^\/wall-?[1-9]\d*_[1-9]\d*$/.test(source.pathname)
      || source.search || source.hash || source.username || source.password) {
    throw new ShareError('INVALID_SOURCE');
  }
  if (typeof campaign.message !== 'string' || campaign.message.length > 1000) {
    throw new ShareError('INVALID_MESSAGE');
  }
  return { ...campaign, ...media, id: key };
}

export function buildMiniAppLink(appId, campaignId) {
  const params = new URLSearchParams({ post: positiveId(campaignId) });
  return `https://vk.ru/app${positiveId(appId)}#${params}`;
}

export function validPostResult(result) {
  if (!result || typeof result !== 'object') return false;
  const value = result.post_id;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== 'string') return false;
  try {
    if (/^[1-9]\d*$/.test(value)) { positiveId(value); return true; }
    const match = /^(-?[1-9]\d*)_([1-9]\d*)$/.exec(value);
    if (!match) return false;
    positiveId(match[1].replace(/^-/, '')); positiveId(match[2]);
    return true;
  } catch { return false; }
}

// Only these diagnostic fields can leave the controller. Raw bridge errors and
// launch parameters may contain personal data and are deliberately excluded.
export function diagnosticFields(error) {
  const fields = {};
  if (error instanceof ShareError) fields.code = error.code;
  const type = error?.error_type;
  if (['client_error', 'api_error', 'auth_error'].includes(type)) fields.type = type;
  const code = error?.error_data?.error_code;
  if (Number.isSafeInteger(code)) fields.bridgeCode = code;
  return fields;
}

export function withTimeout(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ShareError('INIT_TIMEOUT')), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createPublisher({ bridge, campaign, onState = () => {}, log = () => {},
  slowAfterMs = 45000, now = () => performance.now() }) {
  let state = 'ready';
  let pending;
  const update = (next) => { state = next; onState(next); };
  return {
    get state() { return state; },
    open() {
      if (pending) return pending;
      // Never automatically create a second post after success or an ambiguous
      // response. Rejections may be retried only by another explicit click.
      if (state === 'published' || state === 'unconfirmed') return Promise.resolve(state);
      update('opening');
      const started = now();
      log('info', 'composer.open', { campaign: campaign.id, mediaKind: campaign.kind });
      const timer = setTimeout(() => {
        update('waiting'); log('warning', 'composer.waiting', { elapsedMs: Math.round(now() - started) });
      }, slowAfterMs);
      pending = Promise.resolve().then(() => bridge.send('VKWebAppShowWallPostBox', {
        message: campaign.message,
        attachments: campaign.attachment,
      })).then((result) => {
        const next = validPostResult(result) ? 'published' : 'unconfirmed';
        update(next);
        log(next === 'published' ? 'info' : 'warning', `composer.${next}`, {
          elapsedMs: Math.round(now() - started),
        });
        return next;
      }).catch((error) => {
        update('not_published');
        log('warning', 'composer.not_confirmed', {
          ...diagnosticFields(error), elapsedMs: Math.round(now() - started),
        });
        return 'not_published';
      }).finally(() => { clearTimeout(timer); pending = undefined; });
      return pending;
    },
  };
}
