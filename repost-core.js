import { ShareError, positiveId, diagnosticFields, validPostResult, withTimeout } from './core.js?v=0.4.0';

export function repostTarget(campaign) {
  const source = new URL(campaign.sourceUrl);
  const match = /^\/wall(-?[1-9]\d*)_([1-9]\d*)$/.exec(source.pathname);
  if (source.origin !== 'https://vk.ru' || !match || source.search || source.hash || source.username || source.password) {
    throw new ShareError('INVALID_SOURCE');
  }
  positiveId(match[1].replace(/^-/, '')); positiveId(match[2]);
  return { object: `wall${match[1]}_${match[2]}`, ownerId: Number(match[1]), postId: Number(match[2]) };
}

export function createReposter({ bridge, appId, campaign, callAPI, onState = () => {}, onDiagnostic = () => {}, log = () => {},
  requestTimeoutMs = 15000 }) {
  const applicationId = Number(positiveId(appId));
  const target = repostTarget(campaign);
  const request = callAPI ?? ((method, params) => bridge.send('VKWebAppCallAPIMethod', { method, params }));
  let pending;
  let terminal = false;
  return {
    run() {
      if (pending) return pending;
      if (terminal) return Promise.resolve('locked');
      let submitted = false;
      let token;
      let phase = 'AUTH';
      let context = {};
      const started = performance.now();
      const update = (state) => onState(state);
      pending = Promise.resolve().then(async () => {
        update('authorizing'); log('info', 'repost.authorizing', { campaign: campaign.id });
        // This is an interactive VK permission dialog. No timeout cancels or
        // reopens it while the user may still be making a decision.
        const auth = await bridge.send('VKWebAppGetAuthToken', { app_id: applicationId, scope: 'wall' });
        phase = 'PERMISSION';
        context = {
          receivedToken: typeof auth?.access_token === 'string' && Boolean(auth.access_token),
          wallGranted: typeof auth?.scope === 'string' && auth.scope.split(',').map((x) => x.trim()).includes('wall'),
          scopeType: typeof auth?.scope,
        };
        log('info', 'repost.permission_checked', context);
        if (!context.receivedToken || !context.wallGranted) {
          throw new ShareError('WALL_PERMISSION_MISSING');
        }
        token = auth.access_token;
        phase = 'SOURCE_REQUEST'; context = {};
        update('checking');
        const checked = await withTimeout(request('wall.getById', { v: '5.199', access_token: token,
          posts: `${target.ownerId}_${target.postId}` }), requestTimeoutMs);
        phase = 'SOURCE_RESULT';
        const items = checked?.response?.items;
        context = {
          responseType: Array.isArray(checked?.response) ? 'array' : typeof checked?.response,
          itemsCount: Array.isArray(items) ? items.length : null,
        };
        log('info', 'repost.source_received', context);
        const post = Array.isArray(items) && items.length === 1 ? items[0] : undefined;
        if (post?.owner_id !== target.ownerId || post?.id !== target.postId) {
          throw new ShareError('SOURCE_NOT_CONFIRMED');
        }
        phase = 'REPOST_STATUS';
        context = { flagType: typeof post.reposts?.user_reposted };
        let userReposted = post.reposts?.user_reposted;
        // user_reposted is optional in wall.getById. If unavailable, ask the
        // documented read-only endpoint; copied describes the same action.
        if (userReposted !== 0 && userReposted !== 1) {
          phase = 'REPOST_STATUS_REQUEST'; context = {};
          log('info', 'repost.status_fallback');
          const statusResult = await withTimeout(request('likes.isLiked', { v: '5.199', access_token: token,
            type: 'post', owner_id: target.ownerId, item_id: target.postId }), requestTimeoutMs);
          phase = 'REPOST_STATUS_RESULT';
          userReposted = statusResult?.response?.copied;
          context = { copiedType: typeof userReposted };
          if (userReposted !== 0 && userReposted !== 1) throw new ShareError('REPOST_STATUS_UNKNOWN');
        }
        if (userReposted === 1) {
          terminal = true; update('already'); log('info', 'repost.already'); return 'already';
        }
        phase = 'REPOST_REQUEST'; context = {};
        update('publishing'); submitted = true;
        const result = await withTimeout(request('wall.repost', {
          v: '5.199', access_token: token, object: target.object,
        }), requestTimeoutMs);
        terminal = true;
        const state = result?.response?.success === 1 && validPostResult(result.response) ? 'published' : 'unconfirmed';
        if (state === 'unconfirmed') onDiagnostic({ phase: 'REPOST_RESULT', code: 'RESULT_NOT_CONFIRMED' });
        update(state);
        log(state === 'published' ? 'info' : 'warning', `repost.${state}`, {
          elapsedMs: Math.round(performance.now() - started),
        });
        return state;
      }).catch((error) => {
        if (submitted && error instanceof ShareError && error.code === 'PROCEDURE_ALREADY_REPOSTED') {
          terminal = true; update('already'); log('info', 'repost.already'); return 'already';
        }
        // Never repeat a potentially completed wall.repost, including after a
        // timeout or network error. Pre-write permission/read failures may be
        // retried only by another explicit user action.
        if (submitted) terminal = true;
        const state = submitted ? 'unconfirmed' : 'denied';
        const diagnostic = { phase, ...diagnosticFields(error), ...context };
        onDiagnostic(diagnostic);
        update(state);
        log('warning', `repost.${state}`, {
          ...diagnostic, elapsedMs: Math.round(performance.now() - started),
        });
        return state;
      }).finally(() => { token = undefined; pending = undefined; });
      return pending;
    },
  };
}
