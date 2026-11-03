import test from 'node:test';
import assert from 'node:assert/strict';
import { createReposter, repostTarget } from '../repost-core.js';
import { selectCampaign } from '../core.js';
import { campaigns, defaultCampaign } from '../campaigns.js';
const campaign = selectCampaign('', campaigns, defaultCampaign);
const source = { owner_id: -218885671, id: 6311, reposts: { user_reposted: 0 } };
function fake({ scope = 'wall', post = source, result = { success: 1, post_id: 123 }, failWrite = false,
  copied = 0, failStatus = false } = {}) {
  const calls = [];
  return { calls, bridge: { send: async (method, params) => {
    calls.push([method, params]);
    if (method === 'VKWebAppGetAuthToken') return { access_token: 'test-token', scope };
    if (params.method === 'wall.getById') return { response: { items: post ? [post] : [] } };
    if (params.method === 'likes.isLiked') {
      if (failStatus) throw { error_type: 'api_error', error_data: { error_code: 15 } };
      return { response: { liked: 0, copied } };
    }
    if (failWrite) throw { error_type: 'api_error', error_data: { error_code: 15, token: 'test-token' } };
    return { response: result };
  } } };
}
test('repost targets the original wall post, not the clip video', () => {
  assert.deepEqual(repostTarget(campaign), { object: 'wall-218885671_6311', ownerId: -218885671, postId: 6311 });
  assert.throws(() => repostTarget({ sourceUrl: 'https://evil.example/wall1_2' }));
});
test('explicit action requests only wall scope and sends one original repost', async () => {
  const f = fake();
  const r = createReposter({ ...f, appId: 123, campaign });
  assert.equal(f.calls.length, 0);
  assert.equal(await r.run(), 'published');
  assert.deepEqual(f.calls.at(-1), ['VKWebAppCallAPIMethod', { method: 'wall.repost',
    params: { v: '5.199', access_token: 'test-token', object: 'wall-218885671_6311' } }]);
  assert.equal(await r.run(), 'locked');
  assert.equal(f.calls.filter(([, p]) => p.method === 'wall.repost').length, 1);
});
test('missing wall permission cannot publish', async () => {
  const f = fake({ scope: 'friends' });
  assert.equal(await createReposter({ ...f, appId: 123, campaign }).run(), 'denied');
  assert.equal(f.calls.length, 1);
});
test('existing repost does not trigger another write', async () => {
  const f = fake({ post: { ...source, reposts: { user_reposted: 1 } } });
  assert.equal(await createReposter({ ...f, appId: 123, campaign }).run(), 'already');
  assert.equal(f.calls.length, 2);
});
test('wrong or missing source prevents mutation', async () => {
  for (const post of [null, { ...source, id: 6312 }]) {
    const f = fake({ post });
    assert.equal(await createReposter({ ...f, appId: 123, campaign }).run(), 'denied');
    assert.equal(f.calls.length, 2);
  }
});

test('missing optional flag uses copied=0 and publishes the original once', async () => {
  const f = fake({ post: { ...source, reposts: {} } });
  const r = createReposter({ ...f, appId: 123, campaign });
  assert.equal(await r.run(), 'published');
  assert.deepEqual(f.calls[2], ['VKWebAppCallAPIMethod', { method: 'likes.isLiked', params: {
    v: '5.199', access_token: 'test-token', type: 'post', owner_id: -218885671, item_id: 6311,
  } }]);
  assert.equal(f.calls.filter(([, p]) => p.method === 'wall.repost').length, 1);
  assert.equal(await r.run(), 'locked');
});

test('fallback copied=1 does not create a duplicate', async () => {
  const f = fake({ post: { ...source, reposts: {} }, copied: 1 });
  assert.equal(await createReposter({ ...f, appId: 123, campaign }).run(), 'already');
  assert.equal(f.calls.filter(([, p]) => p.method === 'wall.repost').length, 0);
});

test('a malformed or failed fallback never authorizes a write', async () => {
  for (const options of [{ copied: null }, { copied: '0' }, { copied: false }, { failStatus: true }]) {
    const f = fake({ ...options, post: { ...source, reposts: {} } });
    assert.equal(await createReposter({ ...f, appId: 123, campaign }).run(), 'denied');
    assert.equal(f.calls.filter(([, p]) => p.method === 'wall.repost').length, 0);
  }
});

test('a known numeric flag does not add an unnecessary fallback request', async () => {
  const f = fake();
  assert.equal(await createReposter({ ...f, appId: 123, campaign }).run(), 'published');
  assert.equal(f.calls.filter(([, p]) => p.method === 'likes.isLiked').length, 0);
});
test('ambiguous success and API error never retry the write or leak credentials', async () => {
  for (const options of [{ result: {} }, { failWrite: true }]) {
    const f = fake(options); const logs = [];
    const r = createReposter({ ...f, appId: 123, campaign, log: (...args) => logs.push(args) });
    assert.equal(await r.run(), 'unconfirmed');
    assert.equal(await r.run(), 'locked');
    assert.equal(f.calls.length, 3);
    assert.equal(JSON.stringify(logs).includes('test-token'), false);
  }
});
test('double click shares the same request through the interactive permission stage', async () => {
  const f = fake(); const r = createReposter({ ...f, appId: 123, campaign });
  const a = r.run(); const b = r.run();
  assert.equal(a, b); await a;
  assert.equal(f.calls.length, 3);
});
test('a timed out write remains locked even if the transport never resolves', async () => {
  const f = fake(); const send = f.bridge.send;
  f.bridge.send = (method, params) => params.method === 'wall.repost' ? new Promise(() => {}) : send(method, params);
  const r = createReposter({ ...f, appId: 123, campaign, requestTimeoutMs: 5 });
  assert.equal(await r.run(), 'unconfirmed');
  assert.equal(await r.run(), 'locked');
});

