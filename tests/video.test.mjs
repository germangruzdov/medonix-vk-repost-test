import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoPublisher, sourceMedia, confirmedVideo, publicationHasVideo } from '../video-core.js';
import { campaigns, defaultCampaign } from '../campaigns.js';
import { selectCampaign } from '../core.js';

const campaign = selectCampaign('', campaigns, defaultCampaign);
const video = { owner_id: -218885671, id: 456239373 };
const source = (kind = 'video') => ({ response: { items: [{ owner_id: -218885671, id: 6311,
  attachments: [{ type: kind, [kind]: video }], text: 'private source text',
}] } });
const publication = (attachments = [{ type: 'video', video }]) => ({ response: { items: [
  { owner_id: 123, id: 456, attachments, text: 'private post text' },
] } });
function fake({ kind = 'video', scope = 'wall', sourceResult = source(kind),
  videoResult = { response: { items: [video] } }, postResult = publication(),
  nativeResult = { post_id: 456 }, failAt, error, hangingAt, slowAfterMs = 1000 } = {}) {
  const calls = []; const logs = []; const diagnostics = []; const states = [];
  const bridge = { send: async (method, params) => {
    const operation = method === 'VKWebAppCallAPIMethod' ? params.method : method;
    calls.push([operation, params]);
    if (operation === hangingAt) return new Promise(() => {});
    if (operation === failAt) throw error ?? { error_type: 'api_error', error_data: {
      error_code: 15, error_msg: 'private error text', request_params: ['private-token'],
    } };
    if (operation === 'VKWebAppGetAuthToken') return { access_token: 'private-token', scope };
    if (operation === 'wall.getById') return params.params.posts === '-218885671_6311' ? sourceResult : postResult;
    if (operation === 'video.get') return videoResult;
    if (operation === 'VKWebAppShowWallPostBox') return nativeResult;
    throw new Error('Unexpected bridge operation');
  } };
  const publisher = createVideoPublisher({ bridge, appId: 54874242, userId: 123, campaign,
    requestTimeoutMs: 10, slowAfterMs, log: (...args) => logs.push(args),
    onDiagnostic: (value) => diagnostics.push(value), onState: (value) => states.push(value) });
  return { publisher, calls, logs, diagnostics, states };
}

test('preparation reads the exact source and opens no editor before a click', async () => {
  const f = fake();
  assert.equal(await f.publisher.open(), 'not_ready');
  assert.equal(await f.publisher.prepare(), true);
  assert.equal(f.publisher.state, 'ready');
  assert.deepEqual(f.calls.map(([method]) => method), ['VKWebAppGetAuthToken', 'wall.getById']);
  assert.equal(f.calls[1][1].params.posts, '-218885671_6311');
  assert.equal(await f.publisher.prepare(), true);
  assert.equal(f.calls.length, 2);
});

test('only one video goes to the native editor, and success requires a verified post', async () => {
  const f = fake(); await f.publisher.prepare();
  assert.equal(await f.publisher.open(), 'published');
  const native = f.calls.find(([method]) => method === 'VKWebAppShowWallPostBox');
  assert.deepEqual(native[1], { message: campaign.message, attachments: 'video-218885671_456239373' });
  assert.equal(f.calls.at(-1)[1].params.posts, '123_456');
  assert.deepEqual(f.states.slice(-3), ['opening', 'verifying', 'published']);
  await f.publisher.open();
  assert.equal(f.calls.filter(([method]) => method === 'VKWebAppShowWallPostBox').length, 1);
  assert.equal(f.calls.some(([method]) => ['wall.post', 'wall.repost'].includes(method)), false);
});

test('a clip must be confirmed by video.get before it is attached as video', async () => {
  const f = fake({ kind: 'clip' });
  assert.equal(await f.publisher.prepare(), true);
  assert.deepEqual(f.calls.map(([method]) => method), ['VKWebAppGetAuthToken', 'wall.getById', 'video.get']);
  assert.equal(f.calls[2][1].params.videos, '-218885671_456239373');
  assert.equal(await f.publisher.open(), 'published');
});

test('a missing, wrong, denied or malformed clip object cannot reach the editor', async () => {
  for (const videoResult of [null, { response: [] }, { response: { items: [] } },
    { response: { items: [{ ...video, id: 99 }] } }, { response: { items: [{ ...video, can_repost: 0 }] } }]) {
    const f = fake({ kind: 'clip', videoResult });
    assert.equal(await f.publisher.prepare(), false);
    assert.equal(await f.publisher.open(), 'not_ready');
    assert.equal(f.calls.some(([method]) => method === 'VKWebAppShowWallPostBox'), false);
  }
  const f = fake({ kind: 'clip', failAt: 'video.get' });
  assert.equal(await f.publisher.prepare(), false);
  assert.equal(f.diagnostics[0].phase, 'CLIP_VIDEO_CHECK');
});

test('missing wall scope, wrong source, unrelated video and empty attachments stop preparation', async () => {
  for (const options of [{ scope: '' }, { sourceResult: null }, { sourceResult: { response: [] } },
    { sourceResult: { response: { items: [{ owner_id: -218885671, id: 6312, attachments: [] }] } } },
    { sourceResult: { response: { items: [{ owner_id: -218885671, id: 6311,
      attachments: [{ type: 'video', video: { ...video, id: 99 } }] }] } } },
    { sourceResult: { response: { items: [{ owner_id: -218885671, id: 6311, attachments: null }] } } }]) {
    const f = fake(options);
    assert.equal(await f.publisher.prepare(), false);
    assert.equal(f.publisher.state, 'error');
    assert.equal(f.calls.some(([method]) => method === 'VKWebAppShowWallPostBox'), false);
  }
});

test('double preparation and double publication share the pending operations', async () => {
  const f = fake();
  const first = f.publisher.prepare();
  assert.equal(first, f.publisher.prepare()); await first;
  const posting = f.publisher.open(); assert.equal(posting, f.publisher.open()); await posting;
  assert.equal(f.calls.filter(([method]) => method === 'VKWebAppGetAuthToken').length, 1);
  assert.equal(f.calls.filter(([method]) => method === 'VKWebAppShowWallPostBox').length, 1);
});

test('success with no selected video, wrong wall or an unreadable new post stays locked', async () => {
  for (const postResult of [publication([]), publication([{ type: 'video', video: { ...video, id: 99 } }]),
    { response: { items: [{ owner_id: 124, id: 456, attachments: [{ type: 'video', video }] }] } }, null]) {
    const f = fake({ postResult }); await f.publisher.prepare();
    assert.equal(await f.publisher.open(), 'unconfirmed');
    assert.equal(await f.publisher.open(), 'unconfirmed');
    assert.equal(f.diagnostics[0].code, 'PUBLISHED_VIDEO_NOT_CONFIRMED');
    assert.equal(f.calls.filter(([method]) => method === 'VKWebAppShowWallPostBox').length, 1);
  }
});

test('a composite post ID is accepted only for the current VK user', async () => {
  const valid = fake({ nativeResult: { post_id: '123_456' } }); await valid.publisher.prepare();
  assert.equal(await valid.publisher.open(), 'published');
  const invalid = fake({ nativeResult: { post_id: '124_456' } }); await invalid.publisher.prepare();
  assert.equal(await invalid.publisher.open(), 'unconfirmed');
  assert.equal(invalid.calls.length, 3);
});

test('a cancelled native dialog permits only an explicit second open', async () => {
  const f = fake({ failAt: 'VKWebAppShowWallPostBox', error: { error_type: 'client_error', error_data: { error_code: 4 } } });
  await f.publisher.prepare();
  assert.equal(await f.publisher.open(), 'not_published');
  assert.equal(f.calls.filter(([method]) => method === 'VKWebAppShowWallPostBox').length, 1);
  await f.publisher.open();
  assert.equal(f.calls.filter(([method]) => method === 'VKWebAppShowWallPostBox').length, 2);
});

test('ambiguous native failures and invalid results stay locked', async () => {
  for (const options of [{ failAt: 'VKWebAppShowWallPostBox' }, { nativeResult: {} }]) {
    const f = fake(options); await f.publisher.prepare();
    assert.equal(await f.publisher.open(), 'unconfirmed');
    assert.equal(await f.publisher.open(), 'unconfirmed');
    assert.equal(f.calls.filter(([method]) => method === 'VKWebAppShowWallPostBox').length, 1);
  }
});

test('read timeouts terminate preparation and cannot open an empty composer', async () => {
  const f = fake({ hangingAt: 'wall.getById' });
  assert.equal(await f.publisher.prepare(), false);
  assert.equal(f.publisher.state, 'error');
  assert.equal(f.diagnostics[0].code, 'INIT_TIMEOUT');
  assert.equal(await f.publisher.open(), 'not_ready');
});

test('logs exclude access tokens, user IDs, post IDs and source text', async () => {
  for (const options of [{}, { kind: 'clip', failAt: 'video.get' }, { postResult: null }]) {
    const f = fake(options); await f.publisher.prepare(); await f.publisher.open();
    const text = JSON.stringify([f.logs, f.diagnostics]);
    for (const secret of ['private-token', 'private source text', 'private post text', 'private error text',
      'access_token', 'request_params', 'user_id', 'post_id']) assert.equal(text.includes(secret), false, secret);
  }
});

test('unsafe IDs, unrelated campaigns and malformed API shapes are rejected', () => {
  assert.throws(() => createVideoPublisher({ bridge: {}, appId: 0, userId: 123, campaign }));
  assert.throws(() => createVideoPublisher({ bridge: {}, appId: 54874242, userId: '123&bad=1', campaign }));
  assert.throws(() => sourceMedia({ ...campaign, sourceUrl: 'https://evil.example/wall-218885671_6311' }, source()));
  assert.throws(() => sourceMedia(campaign, { response: { items: [{ owner_id: -218885671, id: 6311,
    attachments: [{ type: 'clip', clip: { ...video, can_repost: false } }] }] } }));
  assert.throws(() => confirmedVideo(video, { response: { items: [null] } }));
  assert.equal(publicationHasVideo(null, 456, 123, video), false);
});
