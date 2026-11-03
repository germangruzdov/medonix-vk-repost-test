import test from 'node:test';
import assert from 'node:assert/strict';
import { createVKHttpCaller } from '../vk-http.js';
import { createReposter } from '../repost-core.js';
import { entryRoute } from '../entry.js?manual=1';
import { campaigns, defaultCampaign } from '../campaigns.js';
import { selectCampaign } from '../core.js';

const campaign = selectCampaign('', campaigns, defaultCampaign);
const token = 'vk1.test+token/value';
const params = { v: '5.199', access_token: token, object: 'wall-218885671_6311' };
const json = (value, init = {}) => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' }, ...init,
});
function fixture({ sourceFlag = 0, copied = 0, failAt, apiCode, scope = 'wall', sourceId = 6311,
  nativeError, result = { success: 1, post_id: 456 }, timeoutMs = 200 } = {}) {
  const calls = []; const logs = []; const diagnostics = []; const native = [];
  const callAPI = createVKHttpCaller({ campaign, timeoutMs, log: (...args) => logs.push(args),
    fetchImpl: async (url, options) => {
      const method = url.split('/').at(-1);
      calls.push({ method, url, options });
      if (method === failAt) {
        if (apiCode) return json({ error: { error_code: apiCode, error_msg: `private ${token}`,
          request_params: [{ key: 'access_token', value: token }] } });
        throw new TypeError(`Network or CORS failure ${token}`);
      }
      if (method === 'wall.getById') return json({ response: { items: [{ owner_id: -218885671, id: sourceId,
        reposts: sourceFlag === undefined ? {} : { user_reposted: sourceFlag }, text: 'private post text',
      }] } });
      if (method === 'likes.isLiked') return json({ response: { liked: 0, copied } });
      return json({ response: result });
    } });
  const bridge = { send: async (method, values) => {
    native.push([method, values]);
    assert.equal(method, 'VKWebAppGetAuthToken');
    if (nativeError) throw nativeError;
    return { access_token: token, scope };
  } };
  const reposter = createReposter({ bridge, appId: 54874242, campaign, callAPI,
    log: (...args) => logs.push(args), onDiagnostic: (value) => diagnostics.push(value) });
  return { reposter, calls, logs, diagnostics, native };
}

test('the direct transport uses one fixed HTTPS destination and keeps the token out of the URL', async () => {
  const calls = [];
  const call = createVKHttpCaller({ campaign, fetchImpl: async (...args) => {
    calls.push(args); return json({ response: { success: 1, post_id: 456 } });
  } });
  await call('wall.repost', params);
  const [url, options] = calls[0];
  assert.equal(url, 'https://api.vk.com/method/wall.repost');
  assert.equal(url.includes(token), false);
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.mode, 'cors');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.body.get('access_token'), token);
  assert.equal(options.body.get('object'), 'wall-218885671_6311');
  assert.equal(calls.length, 1);
});

test('unapproved methods, extra fields, different targets and invalid tokens never leave the page', async () => {
  let count = 0;
  const call = createVKHttpCaller({ campaign, fetchImpl: async () => { count++; return json({ response: {} }); } });
  for (const [method, values] of [['wall.post', params], ['https://evil.example/', params],
    ['__proto__', params], ['wall.repost', { ...params, object: 'wall-1_1' }],
    ['wall.repost', { ...params, group_id: 1 }], ['wall.repost', { ...params, access_token: '' }],
    ['wall.repost', { ...params, access_token: 'bad token' }], ['wall.repost', { ...params, v: '5.1' }],
    ['likes.isLiked', { v: '5.199', access_token: token, type: 'post', owner_id: -1, item_id: 6311 }]]) {
    await assert.rejects(call(method, values), { code: 'HTTP_INVALID_REQUEST' });
  }
  assert.equal(count, 0);
});

test('a successful direct flow checks the source, publishes once and never calls Bridge API', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  const first = f.reposter.run(); assert.equal(first, f.reposter.run());
  assert.equal(await first, 'published');
  assert.deepEqual(f.calls.map((call) => call.method), ['wall.getById', 'wall.repost']);
  assert.equal(f.native.length, 1);
  assert.deepEqual(f.native[0], ['VKWebAppGetAuthToken', { app_id: 54874242, scope: 'wall' }]);
  assert.equal(await f.reposter.run(), 'locked');
  assert.equal(f.calls.length, 2);
});

test('existing reposts and missing wall permissions cannot trigger a direct write', async () => {
  const already = fixture({ sourceFlag: 1 });
  assert.equal(await already.reposter.run(), 'already');
  assert.equal(already.calls.length, 1);
  const denied = fixture({ scope: 'friends' });
  assert.equal(await denied.reposter.run(), 'denied');
  assert.equal(denied.calls.length, 0);
});

test('a direct likes fallback can detect a repost or stop malformed answers', async () => {
  for (const copied of [0, 1, null]) {
    const f = fixture({ sourceFlag: null, copied });
    assert.equal(await f.reposter.run(), copied === 0 ? 'published' : copied === 1 ? 'already' : 'denied');
    assert.equal(f.calls[1].method, 'likes.isLiked');
    assert.equal(f.calls.filter((call) => call.method === 'wall.repost').length, copied === 0 ? 1 : 0);
  }
});

test('source/CORS failures stop before a write and do not trigger transport fallback', async () => {
  for (const options of [{ failAt: 'wall.getById' }, { failAt: 'wall.getById', apiCode: 5 }, { sourceId: 99 }]) {
    const f = fixture(options);
    assert.equal(await f.reposter.run(), 'denied');
    assert.equal(f.calls.some((call) => call.method === 'wall.repost'), false);
    assert.equal(f.native.length, 1);
  }
});

test('API refusal, a network failure after sending and invalid write replies stay locked', async () => {
  for (const options of [{ failAt: 'wall.repost', apiCode: 20 }, { failAt: 'wall.repost', apiCode: 15 },
    { failAt: 'wall.repost' }, { result: {} }]) {
    const f = fixture(options);
    assert.equal(await f.reposter.run(), 'unconfirmed');
    assert.equal(await f.reposter.run(), 'locked');
    assert.equal(f.calls.filter((call) => call.method === 'wall.repost').length, 1);
    const text = JSON.stringify([f.logs, f.diagnostics]);
    for (const secret of [token, 'private post text', 'request_params', 'error_msg', 'access_token']) {
      assert.equal(text.includes(secret), false, secret);
    }
    if (options.apiCode) assert.deepEqual(f.diagnostics[0], {
      phase: 'REPOST_REQUEST', type: 'api_error', bridgeCode: options.apiCode,
    });
  }
});

test('non-success HTTP statuses are explicit and never retried', async () => {
  for (const status of [401, 403, 404, 409, 422, 429, 500]) {
    let count = 0;
    const call = createVKHttpCaller({ campaign, fetchImpl: async () => { count++; return new Response('', { status }); } });
    await assert.rejects(call('wall.repost', params), { code: `HTTP_STATUS_${status}` });
    assert.equal(count, 1);
  }
});

test('invalid JSON, missing response and malformed API errors are rejected', async () => {
  for (const body of ['not json', 'null', '[]', '{}', '{"error":{"error_code":"15"}}']) {
    const call = createVKHttpCaller({ campaign, fetchImpl: async () => new Response(body) });
    await assert.rejects(call('wall.repost', params), { code: 'HTTP_INVALID_RESPONSE' });
  }
});

test('oversized declared and streamed responses are bounded', async () => {
  for (const response of [new Response('{}', { headers: { 'Content-Length': String(300000) } }),
    new Response('x'.repeat(256 * 1024 + 1))]) {
    const call = createVKHttpCaller({ campaign, fetchImpl: async () => response });
    await assert.rejects(call('wall.repost', params), { code: 'HTTP_RESPONSE_TOO_LARGE' });
  }
});

test('a timed out HTTP request is aborted with no automatic second request', async () => {
  let count = 0; let aborted = false;
  const call = createVKHttpCaller({ campaign, timeoutMs: 5, fetchImpl: async (_url, options) => {
    count++;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
      aborted = true; reject(new DOMException('private error', 'AbortError'));
    }));
  } });
  await assert.rejects(call('wall.repost', params), { code: 'HTTP_TIMEOUT' });
  assert.equal(aborted, true); assert.equal(count, 1);
});

test('only the explicitly selected experiment can enter the direct route', () => {
  assert.deepEqual(entryRoute('#post=6311'), { mode: 'video', campaignHash: '#post=6311' });
  assert.deepEqual(entryRoute('#post=6311&experiment=http-repost'), {
    mode: 'http-repost', campaignHash: '#post=6311',
  });
  for (const hash of ['#experiment=http-repost&experiment=http-repost', '#post=999&experiment=http-repost',
    '#post=6311&experiment=proxy', '#post=6311&experiment=http-repost&url=https://evil.example',
    '#post=6311&post=6311&experiment=http-repost', '#experiment=' + 'x'.repeat(300)]) assert.throws(() => entryRoute(hash));
});
