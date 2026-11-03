import { ShareError, diagnosticFields } from './core.js?v=0.4.0';
import { repostTarget } from './repost-core.js?v=0.4.0';

const API_ROOT = 'https://api.vk.com/method/';
const MAX_RESPONSE_BYTES = 256 * 1024;

async function readJSON(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new ShareError('HTTP_RESPONSE_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) throw new ShareError('HTTP_INVALID_RESPONSE');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ShareError('HTTP_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let result;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ShareError('HTTP_INVALID_RESPONSE'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ShareError('HTTP_INVALID_RESPONSE');
  if (Object.hasOwn(result, 'error')) {
    const code = result.error?.error_code;
    if (!Number.isSafeInteger(code) || code < 1) throw new ShareError('HTTP_INVALID_RESPONSE');
    // VK can echo credentials in error_msg/request_params; retain only the code.
    throw { error_type: 'api_error', error_data: { error_code: code } };
  }
  if (!Object.hasOwn(result, 'response')) throw new ShareError('HTTP_INVALID_RESPONSE');
  return result;
}

export function createVKHttpCaller({ campaign, fetchImpl = globalThis.fetch.bind(globalThis),
  timeoutMs = 12000, log = () => {} }) {
  const target = repostTarget(campaign);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new ShareError('INVALID_TIMEOUT');
  const allowed = {
    'wall.getById': { posts: `${target.ownerId}_${target.postId}` },
    'likes.isLiked': { type: 'post', owner_id: target.ownerId, item_id: target.postId },
    'wall.repost': { object: target.object },
  };
  return async (method, params) => {
    const fields = typeof method === 'string' && Object.hasOwn(allowed, method) ? allowed[method] : undefined;
    const keys = fields ? ['v', 'access_token', ...Object.keys(fields)] : [];
    if (!fields || !params || typeof params !== 'object' || Array.isArray(params)
      || params.v !== '5.199' || typeof params.access_token !== 'string'
      || !params.access_token || params.access_token.length > 8192 || /\s/.test(params.access_token)
      || Object.keys(params).length !== keys.length || Object.keys(params).some((key) => !keys.includes(key))
      || Object.entries(fields).some(([key, value]) => params[key] !== value)) {
      throw new ShareError('HTTP_INVALID_REQUEST');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    let status;
    log('info', 'http_api.start', { method });
    try {
      const response = await fetchImpl(`${API_ROOT}${method}`, {
        method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams(params),
      });
      status = response.status;
      if (!response.ok) throw new ShareError(`HTTP_STATUS_${status}`);
      const result = await readJSON(response);
      log('info', 'http_api.received', { method, status, elapsedMs: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      const safeError = error instanceof ShareError || error?.error_type === 'api_error' ? error
        : new ShareError(controller.signal.aborted ? 'HTTP_TIMEOUT' : 'HTTP_UNAVAILABLE');
      log('warning', 'http_api.failed', { method, ...(status === undefined ? {} : { status }),
        ...diagnosticFields(safeError), elapsedMs: Math.round(performance.now() - started) });
      throw safeError;
    } finally { clearTimeout(timer); }
  };
}
