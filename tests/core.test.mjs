import test from 'node:test';
import assert from 'node:assert/strict';
import { campaigns, defaultCampaign } from '../campaigns.js';
import { positiveId, parseMediaReference, selectCampaign, buildMiniAppLink, validPostResult,
  diagnosticFields, createPublisher, withTimeout } from '../core.js';

const campaign = selectCampaign('#post=6311', campaigns, defaultCampaign);

test('clip mapping is explicit and marked unverified', () => {
  assert.equal(campaign.kind, 'clip');
  assert.equal(campaign.attachment, 'video-218885671_456239373');
  assert.equal(campaign.mappingVerified, false);
});
test('media parser rejects injection, zero IDs, access keys and unsafe integers', () => {
  for (const input of ['', 'video0_1', 'video1_0', 'video1_2,photo1_2', 'clip1_2_key',
    'clip9007199254740992_1', null, 'https://evil.example/video1_2']) {
    assert.throws(() => parseMediaReference(input));
  }
  assert.deepEqual(parseMediaReference('video123_456'), { kind: 'video', attachment: 'video123_456' });
});
test('visitors can choose only an allowlisted campaign', () => {
  assert.equal(selectCampaign('', campaigns, defaultCampaign).id, '6311');
  for (const hash of ['#post=999', '#post=6311&post=6311', '#post=6311&video=video1_2',
    '#post=__proto__', '#post=', '#post=constructor', '#post=' + 'x'.repeat(210)]) {
    assert.throws(() => selectCampaign(hash, campaigns, defaultCampaign));
  }
});
test('untrusted source domains and message types are rejected', () => {
  for (const sourceUrl of ['https://evil.example/wall-1_1', 'https://vk.ru/wall-1_1?a=1',
    'https://evil@vk.ru/wall-1_1', 'http://vk.ru/wall-1_1']) {
    assert.throws(() => selectCampaign('', { a: { ...campaign, sourceUrl } }, 'a'));
  }
  assert.throws(() => selectCampaign('', { a: { ...campaign, message: null } }, 'a'));
});
test('link builder validates application ID without accepting arbitrary URLs', () => {
  assert.equal(buildMiniAppLink('123456', '6311'), 'https://vk.ru/app123456#post=6311');
  for (const input of ['0', '-1', '1&bad=1', '9007199254740992', 'https://evil.example']) {
    assert.throws(() => buildMiniAppLink(input, '6311'));
  }
  assert.equal(positiveId('123'), '123');
});
test('success requires a valid positive or composite post ID', () => {
  for (const post_id of [1, '123', '123_456']) assert.equal(validPostResult({ post_id }), true);
  for (const value of [null, {}, { post_id: 0 }, { post_id: -1 }, { post_id: '0' },
    { post_id: 'bad' }, { post_id: 1.5 }, { post_id: '9007199254740992' }]) {
    assert.equal(validPostResult(value), false);
  }
});
test('diagnostics exclude secrets, messages, launch data and post IDs', () => {
  const safe = diagnosticFields({ error_type: 'api_error', access_token: 'secret',
    user_id: 123, error_data: { error_code: 15, error_reason: 'private', request_params: 'secret' } });
  assert.deepEqual(safe, { type: 'api_error', bridgeCode: 15 });
  assert.deepEqual(diagnosticFields(new Error('secret')), {});
});
test('composer sends exactly one video to the current user and never calls wall.post', async () => {
  const calls = [];
  const publisher = createPublisher({ campaign, bridge: { send: async (...args) => {
    calls.push(args); return { post_id: 123 };
  } } });
  assert.equal(await publisher.open(), 'published');
  assert.deepEqual(calls, [['VKWebAppShowWallPostBox', {
    message: campaign.message, attachments: 'video-218885671_456239373',
  }]]);
  assert.equal(await publisher.open(), 'published');
  assert.equal(calls.length, 1);
});
test('double clicks share one pending request', async () => {
  let complete;
  let calls = 0;
  const publisher = createPublisher({ campaign, bridge: { send: () => {
    calls++; return new Promise((resolve) => { complete = resolve; });
  } } });
  const first = publisher.open(); const second = publisher.open();
  assert.equal(first, second);
  await Promise.resolve();
  complete({ post_id: 2 });
  await first;
  assert.equal(calls, 1);
});
test('ambiguous response is not reported as success and never auto-retries', async () => {
  let calls = 0;
  const publisher = createPublisher({ campaign, bridge: { send: async () => { calls++; return {}; } } });
  assert.equal(await publisher.open(), 'unconfirmed');
  assert.equal(await publisher.open(), 'unconfirmed');
  assert.equal(calls, 1);
});
test('rejected native dialog permits only an explicit retry and emits safe logs', async () => {
  let calls = 0; const logs = [];
  const publisher = createPublisher({ campaign, log: (...args) => logs.push(args),
    bridge: { send: async () => { calls++; throw { error_type: 'client_error',
      access_token: 'must-not-log', error_data: { error_code: 4, message: 'private' } }; } } });
  assert.equal(await publisher.open(), 'not_published');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(logs).includes('must-not-log'), false);
  assert.equal(JSON.stringify(logs).includes('private'), false);
  await publisher.open(); assert.equal(calls, 2);
});
test('a slow native dialog keeps the lock and accepts a late valid result', async () => {
  let complete; const states = [];
  const publisher = createPublisher({ campaign, slowAfterMs: 10, onState: (state) => states.push(state),
    bridge: { send: () => new Promise((resolve) => { complete = resolve; }) } });
  const pending = publisher.open();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(publisher.state, 'waiting');
  assert.equal(publisher.open(), pending);
  complete({ post_id: '1_2' });
  assert.equal(await pending, 'published');
  assert.deepEqual(states, ['opening', 'waiting', 'published']);
});
test('initialization timeout is bounded; normal result is preserved', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 5), { code: 'INIT_TIMEOUT' });
  assert.equal(await withTimeout(Promise.resolve(true), 50), true);
});

