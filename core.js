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

// Reconstruct client explanations from a fixed technical vocabulary. Unknown
// words, identifiers, numbers and other characters never enter the report.
const diagnosticWords = new Set(('a an the this is are was be been can cannot could not no ' +
  'has have should must only for from to of in on with or and api method methods ' +
  'wall repost post call allowed allow available unavailable supported unsupported ' +
  'access permission permissions denied forbidden restricted restriction ' +
  'client application app version outdated update required user authorization ' +
  'authorized unauthorized authenticated authentication auth invalid missing ' +
  'parameter parameters params request requests response failed failure error unknown ' +
  'network connection timeout timed out too many limit exceeded cancelled canceled ' +
  'closed dialog disabled enabled test mode custom internal service operation ' +
  'perform action platform device token scope found wall.repost wall.post').split(' '));

function clientExplanation(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parts = value.slice(0, 256).toLowerCase().match(/[a-z0-9_]+(?:[./-][a-z0-9_]+)*|\s+|[.,:;()/-]|[^a-z0-9_\s.,:;()/-]+/g) ?? [];
  const safe = parts.map((part) => diagnosticWords.has(part) || /^[\s.,:;()/-]+$/.test(part)
    ? part : '[скрыто]').join('').replace(/(?:\[скрыто\][\s/-]*){2,}/g, '[скрыто] ');
  return safe.trim();
}

export function diagnosticLabel(diagnostic) {
  if (diagnostic.code) return diagnostic.code;
  if (!Number.isSafeInteger(diagnostic.bridgeCode)) return 'NO_CODE';
  const prefix = { client_error: 'CLIENT', api_error: 'API', auth_error: 'AUTH' }[diagnostic.type] ?? 'VK';
  return `${prefix}_${diagnostic.bridgeCode}`;
}

// Raw bridge errors, API messages and launch parameters remain excluded.
export function diagnosticFields(error) {
  const fields = {};
  if (error instanceof ShareError) fields.code = error.code;
  const type = error?.error_type;
  if (['client_error', 'api_error', 'auth_error'].includes(type)) fields.type = type;
  const code = error?.error_data?.error_code;
  if (Number.isSafeInteger(code)) fields.bridgeCode = code;
  if (type === 'client_error') {
    const reason = clientExplanation(error?.error_data?.error_reason);
    const description = clientExplanation(error?.error_data?.error_description);
    if (reason) fields.clientReason = reason;
    if (description) fields.clientDescription = description;
  }
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
