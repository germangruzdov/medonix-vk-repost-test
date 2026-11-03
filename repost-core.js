import { ShareError, positiveId, diagnosticFields, validPostResult, withTimeout } from './core.js';

export function repostTarget(campaign) {
  const source = new URL(campaign.sourceUrl);
  const match = /^\/wall(-?[1-9]\d*)_([1-9]\d*)$/.exec(source.pathname);
  if (source.origin !== 'https://vk.ru' || !match || source.search || source.hash || source.username || source.password) {
    throw new ShareError('INVALID_SOURCE');
  }
  positiveId(match[1].replace(/^-/, '')); positiveId(match[2]);
  return { object: `wall${match[1]}_${match[2]}`, ownerId: Number(match[1]), postId: Number(match[2]) };
}

export function createReposter({ bridge, appId, campaign, onState = () => {}, log = () => {},
  requestTimeoutMs = 15000 }) {
  const applicationId = Number(positiveId(appId));
  const target = repostTarget(campaign);
  let pending;
  let terminal = false;
  return {
    run() {
      if (pending) return pending;
      if (terminal) return Promise.resolve('locked');
      let submitted = false;
      let token;
      const started = performance.now();
      const update = (state) => onState(state);
      pending = Promise.resolve().then(async () => {
        update('authorizing'); log('info', 'repost.authorizing', { campaign: campaign.id });
        // This is an interactive VK permission dialog. No timeout cancels or
        // reopens it while the user may still be making a decision.
        const auth = await bridge.send('VKWebAppGetAuthToken', { app_id: applicationId, scope: 'wall' });
        if (!auth || typeof auth.access_token !== 'string' || !auth.access_token
            || typeof auth.scope !== 'string' || !auth.scope.split(',').map((x) => x.trim()).includes('wall')) {
          throw new ShareError('WALL_PERMISSION_MISSING');
        }
        token = auth.access_token;
        update('checking');
        const checked = await withTimeout(bridge.send('VKWebAppCallAPIMethod', {
          method: 'wall.getById', params: { v: '5.199', access_token: token,
            posts: `${target.ownerId}_${target.postId}` },
        }), requestTimeoutMs);
        const items = checked?.response?.items;
        const post = Array.isArray(items) && items.length === 1 ? items[0] : undefined;
        if (post?.owner_id !== target.ownerId || post?.id !== target.postId) {
          throw new ShareError('SOURCE_NOT_CONFIRMED');
        }
        if (post.reposts?.user_reposted === 1) {
          terminal = true; update('already'); log('info', 'repost.already'); return 'already';
        }
        // A missing flag is not evidence that it is safe to repeat a write.
        if (post.reposts?.user_reposted !== 0) throw new ShareError('REPOST_STATUS_UNKNOWN');
        update('publishing'); submitted = true;
        const result = await withTimeout(bridge.send('VKWebAppCallAPIMethod', {
          method: 'wall.repost', params: { v: '5.199', access_token: token, object: target.object },
        }), requestTimeoutMs);
        terminal = true;
        const state = result?.response?.success === 1 && validPostResult(result.response) ? 'published' : 'unconfirmed';
        update(state);
        log(state === 'published' ? 'info' : 'warning', `repost.${state}`, {
          elapsedMs: Math.round(performance.now() - started),
        });
        return state;
      }).catch((error) => {
        // Never repeat a potentially completed wall.repost, including after a
        // timeout or network error. Pre-write permission/read failures may be
        // retried only by another explicit user action.
        if (submitted) terminal = true;
        const state = submitted ? 'unconfirmed' : 'denied';
        update(state);
        log('warning', `repost.${state}`, {
          ...diagnosticFields(error), elapsedMs: Math.round(performance.now() - started),
        });
        return state;
      }).finally(() => { token = undefined; pending = undefined; });
      return pending;
    },
  };
}
