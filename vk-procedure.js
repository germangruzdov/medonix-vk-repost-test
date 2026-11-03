import { ShareError, validPostResult, diagnosticFields } from './core.js?v=0.4.0';
import { repostTarget } from './repost-core.js?v=0.5.0';

export const PROCEDURE_METHOD = 'execute.medonix_repost6311';

export function createStoredCaller({ bridge, campaign, log = () => {} }) {
  const target = repostTarget(campaign);
  if (target.object !== 'wall-218885671_6311') throw new ShareError('PROCEDURE_TARGET_MISMATCH');
  return async (method, params) => {
    const expected = {
      'wall.getById': { posts: '-218885671_6311' },
      'likes.isLiked': { type: 'post', owner_id: -218885671, item_id: 6311 },
      'wall.repost': { object: target.object },
    };
    const fields = typeof method === 'string' && Object.hasOwn(expected, method) ? expected[method] : undefined;
    const keys = fields ? ['v', 'access_token', ...Object.keys(fields)] : [];
    if (!fields || !params || typeof params !== 'object' || Array.isArray(params)
      || params.v !== '5.199' || typeof params.access_token !== 'string' || !params.access_token
      || params.access_token.length > 8192 || /\s/.test(params.access_token)
      || Object.keys(params).length !== keys.length || Object.keys(params).some((key) => !keys.includes(key))
      || Object.entries(fields).some(([key, value]) => params[key] !== value)) throw new ShareError('PROCEDURE_INVALID_REQUEST');
    // The known working native read calls stay unchanged. Only the write uses
    // the stored procedure, which checks the source and duplicate again in VK.
    if (method !== 'wall.repost') return bridge.send('VKWebAppCallAPIMethod', { method, params });
    const started = performance.now();
    log('info', 'procedure.start', { method: PROCEDURE_METHOD, version: 1 });
    try {
      const result = await bridge.send('VKWebAppCallAPIMethod', { method: PROCEDURE_METHOD,
        params: { v: '5.199', func_v: 1, access_token: params.access_token } });
      const errors = result?.execute_errors;
      if (errors !== undefined && errors !== null) {
        if (!Array.isArray(errors)) throw new ShareError('PROCEDURE_RESULT_UNKNOWN');
        if (errors.length) {
          const code = errors[0]?.error_code;
          if (Number.isSafeInteger(code) && code > 0) throw { error_type: 'api_error', error_data: { error_code: code } };
          throw new ShareError('PROCEDURE_RESULT_UNKNOWN');
        }
      }
      const data = result?.response;
      if (data?.state === 'already') throw new ShareError('PROCEDURE_ALREADY_REPOSTED');
      if (data?.state !== 'published' || !validPostResult(data)) {
        const errors = { source_unavailable: 'PROCEDURE_SOURCE_UNAVAILABLE',
          status_unavailable: 'PROCEDURE_STATUS_UNAVAILABLE', unconfirmed: 'PROCEDURE_RESULT_UNKNOWN' };
        throw new ShareError(Object.hasOwn(errors, data?.state) ? errors[data.state] : 'PROCEDURE_RESULT_UNKNOWN');
      }
      log('info', 'procedure.confirmed', { elapsedMs: Math.round(performance.now() - started) });
      return { response: { success: 1, post_id: data.post_id } };
    } catch (error) {
      if (error instanceof ShareError && error.code === 'PROCEDURE_ALREADY_REPOSTED') {
        log('info', 'procedure.already'); throw error;
      }
      log('warning', 'procedure.failed', { ...diagnosticFields(error), elapsedMs: Math.round(performance.now() - started) });
      throw error;
    }
  };
}
