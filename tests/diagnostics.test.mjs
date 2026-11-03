import test from 'node:test';
import assert from 'node:assert/strict';
import { createReposter } from '../repost-core.js';
import { campaigns, defaultCampaign } from '../campaigns.js';
import { selectCampaign } from '../core.js';

const campaign = selectCampaign('', campaigns, defaultCampaign);
const post = { id: 6311, owner_id: -218885671, reposts: { user_reposted: 0 } };
const secretError = { error_type: 'api_error', error_data: {
  error_code: 15, error_msg: 'private data', access_token: 'do-not-expose', user_id: 12345,
} };
function make({ failAt, failure = secretError, auth = { access_token: 'do-not-expose', scope: 'wall' },
  source = { items: [post] }, result = { success: 1, post_id: 123 }, copied = 0 } = {}) {
  const calls = []; const diagnostics = []; const logs = [];
  const bridge = { send: async (method, params) => {
    const operation = method === 'VKWebAppGetAuthToken' ? 'auth' : params.method;
    calls.push(operation);
    if (operation === failAt) throw failure;
    if (operation === 'auth') return auth;
    if (operation === 'likes.isLiked') return { response: { liked: 0, copied } };
    return { response: operation === 'wall.getById' ? source : result };
  } };
  const reposter = createReposter({ bridge, appId: 54874242, campaign,
    onDiagnostic: (d) => diagnostics.push(d), log: (...args) => logs.push(args) });
  return { reposter, calls, diagnostics, logs };
}
test('authorization errors expose only stage and numeric code, never raw errors', async () => {
  const f = make({ failAt: 'auth' });
  assert.equal(await f.reposter.run(), 'denied');
  assert.deepEqual(f.diagnostics[0], { phase: 'AUTH', type: 'api_error', bridgeCode: 15 });
  const text = JSON.stringify([f.diagnostics, f.logs]);
  for (const secret of ['do-not-expose', 'private data', 'user_id', 'access_token']) assert.equal(text.includes(secret), false);
  assert.deepEqual(f.calls, ['auth']);
});
test('accepted permission dialog with no wall scope is diagnosed separately', async () => {
  const f = make({ auth: { access_token: 'do-not-expose', scope: 'friends' } });
  assert.equal(await f.reposter.run(), 'denied');
  assert.deepEqual(f.diagnostics[0], { phase: 'PERMISSION', code: 'WALL_PERMISSION_MISSING',
    receivedToken: true, wallGranted: false, scopeType: 'string' });
  assert.deepEqual(f.calls, ['auth']);
});
test('a failed source read cannot be confused with denied user consent', async () => {
  const f = make({ failAt: 'wall.getById' });
  assert.equal(await f.reposter.run(), 'denied');
  assert.deepEqual(f.diagnostics[0], { phase: 'SOURCE_REQUEST', type: 'api_error', bridgeCode: 15 });
  assert.deepEqual(f.calls, ['auth', 'wall.getById']);
});
test('unexpected source response records only structure and stops the write', async () => {
  const f = make({ source: [{ ...post, text: 'private data' }] });
  assert.equal(await f.reposter.run(), 'denied');
  assert.deepEqual(f.diagnostics[0], { phase: 'SOURCE_RESULT', code: 'SOURCE_NOT_CONFIRMED',
    responseType: 'array', itemsCount: null });
  assert.equal(JSON.stringify(f.diagnostics).includes('private data'), false);
  assert.equal(f.calls.includes('wall.repost'), false);
});
test('unavailable flag in both endpoints is diagnosed as a fallback result failure', async () => {
  const f = make({ source: { items: [{ ...post, reposts: {} }] }, copied: null });
  assert.equal(await f.reposter.run(), 'denied');
  assert.deepEqual(f.diagnostics[0], { phase: 'REPOST_STATUS_RESULT', code: 'REPOST_STATUS_UNKNOWN', copiedType: 'object' });
  assert.equal(f.calls.includes('wall.repost'), false);
});

test('fallback API failures include a safe stage and numeric code without tokens', async () => {
  const f = make({ source: { items: [{ ...post, reposts: {} }] }, failAt: 'likes.isLiked' });
  assert.equal(await f.reposter.run(), 'denied');
  assert.deepEqual(f.diagnostics[0], { phase: 'REPOST_STATUS_REQUEST', type: 'api_error', bridgeCode: 15 });
  assert.equal(JSON.stringify(f.diagnostics).includes('do-not-expose'), false);
  assert.equal(f.calls.includes('wall.repost'), false);
});
test('write errors stay unconfirmed and locked while retaining safe diagnostics', async () => {
  const f = make({ failAt: 'wall.repost' });
  assert.equal(await f.reposter.run(), 'unconfirmed');
  assert.equal(await f.reposter.run(), 'locked');
  assert.deepEqual(f.diagnostics[0], { phase: 'REPOST_REQUEST', type: 'api_error', bridgeCode: 15 });
  assert.equal(f.calls.filter((x) => x === 'wall.repost').length, 1);
});

test('client 11 after accepted wall permission stays distinct and never retries', async () => {
  const f = make({ failAt: 'wall.repost', failure: { error_type: 'client_error', error_data: {
    error_code: 11, error_reason: 'Access denied', error_description: 'Method is not allowed for wall.repost',
    access_token: 'do-not-expose', request_params: ['private data'],
  } } });
  assert.equal(await f.reposter.run(), 'unconfirmed');
  assert.equal(await f.reposter.run(), 'locked');
  assert.deepEqual(f.diagnostics[0], { phase: 'REPOST_REQUEST', type: 'client_error', bridgeCode: 11,
    clientReason: 'access denied', clientDescription: 'method is not allowed for wall.repost' });
  assert.equal(f.calls.filter((x) => x === 'wall.repost').length, 1);
  const text = JSON.stringify([f.logs, f.diagnostics]);
  for (const secret of ['do-not-expose', 'private data', 'access_token', 'request_params']) assert.equal(text.includes(secret), false);
});
test('a malformed write result is never represented as a confirmed publication', async () => {
  const f = make({ result: {} });
  assert.equal(await f.reposter.run(), 'unconfirmed');
  assert.deepEqual(f.diagnostics[0], { phase: 'REPOST_RESULT', code: 'RESULT_NOT_CONFIRMED' });
});
