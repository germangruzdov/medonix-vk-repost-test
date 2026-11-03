import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStoredCaller, PROCEDURE_METHOD } from '../vk-procedure.js';
import { createReposter } from '../repost-core.js';
import { campaigns, defaultCampaign } from '../campaigns.js';
import { selectCampaign } from '../core.js';
import { entryRoute } from '../entry.js?manual=1';

const campaign = selectCampaign('', campaigns, defaultCampaign);
const code = readFileSync(new URL('../procedures/medonix_repost6311.vkscript.txt', import.meta.url), 'utf8');
// This trusted local artifact uses a JS-compatible subset. This does not test
// VK's compiler: saving the procedure in VK remains a required owner action.
const execute = new Function('API', code);
function script({ source = { items: [{ owner_id: -218885671, id: 6311 }] },
  status = { copied: 0 }, result = { success: 1, post_id: 456 } } = {}) {
  const calls = [];
  const value = execute({ wall: {
    getById: (params) => { calls.push(['wall.getById', params]); return source; },
    repost: (params) => { calls.push(['wall.repost', params]); return result; },
  }, likes: { isLiked: (params) => { calls.push(['likes.isLiked', params]); return status; } } });
  return { calls, value };
}
function flow({ response, executeErrors, rejectProcedure, copied = 0, serverCopied = 0 } = {}) {
  const calls = []; const logs = []; const diagnostics = [];
  const bridge = { send: async (method, params) => {
    calls.push([method, params]);
    if (method === 'VKWebAppGetAuthToken') return { access_token: 'private-token', scope: 'wall' };
    if (params.method === 'wall.getById') return { response: { items: [
      { owner_id: -218885671, id: 6311, reposts: { user_reposted: copied } },
    ] } };
    assert.equal(params.method, PROCEDURE_METHOD);
    if (rejectProcedure) throw { error_type: 'api_error', error_data: {
      error_code: rejectProcedure, request_params: ['private-token'], error_msg: 'private data',
    } };
    return { response: response ?? script({ status: { copied: serverCopied } }).value,
      ...(executeErrors === undefined ? {} : { execute_errors: executeErrors }) };
  } };
  const log = (...args) => logs.push(args);
  const callAPI = createStoredCaller({ bridge, campaign, log });
  return { calls, logs, diagnostics, callAPI, reposter: createReposter({ bridge, appId: 54874242,
    campaign, callAPI, log, onDiagnostic: (value) => diagnostics.push(value) }) };
}

test('the procedure checks the exact source and current-user copied flag before one write', () => {
  const f = script();
  assert.deepEqual(f.value, { state: 'published', post_id: 456 });
  assert.deepEqual(f.calls, [['wall.getById', { posts: '-218885671_6311' }],
    ['likes.isLiked', { type: 'post', owner_id: -218885671, item_id: 6311 }],
    ['wall.repost', { object: 'wall-218885671_6311' }]]);
});

test('an existing repost is stopped on the VK-server side too', () => {
  const f = script({ status: { copied: 1 } });
  assert.deepEqual(f.value, { state: 'already' });
  assert.equal(f.calls.length, 2);
});

test('missing or wrong source and an unavailable copied flag cannot trigger a write', () => {
  for (const source of [false, {}, { items: [] }, { items: [{ owner_id: -1, id: 6311 }] }]) {
    const f = script({ source });
    assert.equal(f.value.state, 'source_unavailable');
    assert.equal(f.calls.length, 1);
  }
  for (const status of [false, {}, { copied: null }, { copied: 2 }]) {
    const f = script({ status });
    assert.equal(f.value.state, 'status_unavailable');
    assert.equal(f.calls.length, 2);
  }
});

test('rejected and malformed write results are never reported as success', () => {
  for (const result of [false, {}, { success: 1 }, { success: 1, post_id: 0 }, { success: 0, post_id: 456 }]) {
    assert.equal(script({ result }).value.state, 'unconfirmed');
  }
});

test('the client uses native reads and exactly one named procedure with the approved token', async () => {
  const f = flow();
  const first = f.reposter.run(); assert.equal(first, f.reposter.run());
  assert.equal(await first, 'published');
  assert.deepEqual(f.calls.map(([method, params]) => params.method ?? method),
    ['VKWebAppGetAuthToken', 'wall.getById', PROCEDURE_METHOD]);
  assert.deepEqual(f.calls.at(-1)[1].params, { v: '5.199', func_v: 1, access_token: 'private-token' });
  assert.equal(await f.reposter.run(), 'locked');
  assert.equal(f.calls.length, 3);
});

test('a copied flag that changes before the server-side check produces already, not a duplicate', async () => {
  const f = flow({ serverCopied: 1 });
  assert.equal(await f.reposter.run(), 'already');
  assert.equal(await f.reposter.run(), 'locked');
  assert.equal(f.logs.some(([, event]) => event === 'procedure.failed'), false);
});

test('missing registration and nested API errors stay explicit and never retry', async () => {
  for (const options of [{ rejectProcedure: 3 }, { executeErrors: [{ error_code: 20, error_msg: 'private-token' }] },
    { response: { state: 'published', post_id: 0 } }, { response: false }, { executeErrors: {} }]) {
    const f = flow(options);
    assert.equal(await f.reposter.run(), 'unconfirmed');
    assert.equal(await f.reposter.run(), 'locked');
    assert.equal(f.calls.filter(([, params]) => params.method === PROCEDURE_METHOD).length, 1);
    const text = JSON.stringify([f.logs, f.diagnostics]);
    for (const secret of ['private-token', 'private data', 'request_params', 'error_msg', 'access_token']) assert.equal(text.includes(secret), false);
  }
});

test('invalid requests and different source campaigns cannot call the procedure', async () => {
  const f = flow();
  await assert.rejects(f.callAPI('wall.repost', { v: '5.199', access_token: 'private-token', object: 'wall-1_1' }),
    { code: 'PROCEDURE_INVALID_REQUEST' });
  assert.equal(f.calls.length, 0);
  assert.throws(() => createStoredCaller({ bridge: {}, campaign: { ...campaign, sourceUrl: 'https://vk.ru/wall-1_1' } }));
});

test('the stored procedure is a separate opt-in route', () => {
  assert.deepEqual(entryRoute('#post=6311&experiment=stored-repost'), { mode: 'stored-repost', campaignHash: '#post=6311' });
});
