import test from 'node:test';
import assert from 'node:assert/strict';

async function setup(t, { insideVK = true, sourceNetworkError = false, apiError, appId = 54874242,
  hash = '#post=6311&experiment=http-repost', storedError } = {}) {
  const keys = ['document', 'window', 'location', 'fetch'];
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const elements = new Map();
  for (const id of ['status', 'publish', 'diagnostic-code', 'diagnostics', 'build-version',
    'diagnostic-output', 'source', 'card', 'open-vk', 'heading', 'eyebrow', 'intro', 'video-icon', 'footnote']) {
    elements.set(id, { textContent: '', dataset: {}, hidden: true, disabled: true,
      listeners: {}, setAttribute() {}, addEventListener(name, callback) { this.listeners[name] = callback; } });
  }
  elements.get('heading').textContent = 'Поделиться видео';
  const nativeCalls = []; const requests = [];
  const response = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  Object.assign(globalThis, {
    document: { getElementById: (id) => elements.get(id), querySelector: (selector) => elements.get(selector.slice(1)) },
    location: { search: '', hash },
    fetch: async (url, options) => {
      const method = url.split('/').at(-1);
      requests.push([method, url, options]);
      if (method === 'wall.getById') {
        if (sourceNetworkError) throw new TypeError('CORS blocked private-token');
        return response({ response: { items: [{ owner_id: -218885671, id: 6311, reposts: { user_reposted: 0 } }] } });
      }
      if (apiError) return response({ error: { error_code: apiError, error_msg: 'private-token',
        request_params: [{ key: 'access_token', value: 'private-token' }] } });
      return response({ response: { success: 1, post_id: 456 } });
    },
    window: { vkBridge: { isWebView: () => insideVK, isIframe: () => false, isEmbedded: () => false,
      send: async (method, params) => {
        nativeCalls.push([method, params]);
        if (method === 'VKWebAppInit') return {};
        if (method === 'VKWebAppGetLaunchParams') return { vk_app_id: appId, vk_user_id: 123 };
        if (method === 'VKWebAppGetAuthToken') return { access_token: 'private-token', scope: 'wall' };
        if (hash.includes('experiment=stored-repost') && method === 'VKWebAppCallAPIMethod') {
          if (params.method === 'wall.getById') return { response: { items: [
            { owner_id: -218885671, id: 6311, reposts: { user_reposted: 0 } },
          ] } };
          assert.equal(params.method, 'execute.medonix_repost6311');
          if (storedError) throw { error_type: 'api_error', error_data: { error_code: storedError } };
          return { response: { state: 'published', post_id: 456 } };
        }
        throw new Error('Bridge API transport must not run in the HTTP experiment');
      },
    } },
  });
  await import(`../entry.js?test=${encodeURIComponent(t.name)}`);
  const waitFor = async (predicate) => {
    for (let i = 0; i < 150; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.fail('UI did not reach the expected state');
  };
  return { elements, nativeCalls, requests, waitFor };
}

test('the test link boots the direct flow without any auth or API request until a click', async (t) => {
  const f = await setup(t);
  await f.waitFor(() => f.elements.get('status').dataset.state === 'ready');
  assert.equal(f.elements.get('heading').textContent, 'Сделать репост');
  assert.equal(f.elements.get('build-version').textContent, 'Версия 0.4.0');
  assert.equal(f.requests.length, 0);
  assert.equal(f.nativeCalls.some(([method]) => method === 'VKWebAppGetAuthToken'), false);
  const button = f.elements.get('publish');
  button.listeners.click(); button.listeners.click();
  await f.waitFor(() => f.elements.get('status').dataset.state === 'published');
  assert.equal(button.disabled, true);
  assert.deepEqual(f.requests.map(([method]) => method), ['wall.getById', 'wall.repost']);
  assert.equal(f.nativeCalls.filter(([method]) => method === 'VKWebAppGetAuthToken').length, 1);
  assert.equal(f.nativeCalls.some(([method]) => method === 'VKWebAppCallAPIMethod'), false);
});

test('a failed direct read shows a network/CORS diagnosis and sends no repost', async (t) => {
  const f = await setup(t, { sourceNetworkError: true });
  await f.waitFor(() => f.elements.get('status').dataset.state === 'ready');
  f.elements.get('publish').listeners.click();
  await f.waitFor(() => f.elements.get('status').dataset.state === 'error');
  assert.deepEqual(f.requests.map(([method]) => method), ['wall.getById']);
  assert.match(f.elements.get('diagnostic-code').textContent, /0\.4\.0 \/ SOURCE_REQUEST \/ HTTP_UNAVAILABLE/);
  assert.match(f.elements.get('status').textContent, /Репост не отправлялся/);
  assert.equal(f.elements.get('diagnostic-output').textContent.includes('private-token'), false);
});

test('an API permission refusal is distinct from the previous client error and stays locked', async (t) => {
  const f = await setup(t, { apiError: 20 });
  await f.waitFor(() => f.elements.get('status').dataset.state === 'ready');
  const button = f.elements.get('publish'); button.listeners.click();
  await f.waitFor(() => f.elements.get('status').dataset.state === 'unconfirmed');
  assert.match(f.elements.get('diagnostic-code').textContent, /REPOST_REQUEST \/ API_20/);
  assert.match(f.elements.get('status').textContent, /API ВК отказал/);
  assert.equal(button.disabled, true);
  button.listeners.click(); await Promise.resolve();
  assert.equal(f.requests.filter(([method]) => method === 'wall.repost').length, 1);
  assert.equal(f.elements.get('diagnostic-output').textContent.includes('private-token'), false);
});

test('the approved HTTP test cannot obtain a token when launched from a different app', async (t) => {
  const f = await setup(t, { appId: 123 });
  await f.waitFor(() => f.elements.get('status').dataset.state === 'error');
  assert.match(f.elements.get('diagnostic-code').textContent, /INIT \/ WRONG_APP/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.nativeCalls.some(([method]) => method === 'VKWebAppGetAuthToken'), false);
  assert.equal(f.elements.get('publish').disabled, true);
});

test('outside VK the direct experiment displays its exact app link and performs no requests', async (t) => {
  const f = await setup(t, { insideVK: false });
  await f.waitFor(() => f.elements.get('status').dataset.state === 'error');
  assert.equal(f.elements.get('publish').textContent, 'Сделать репост на моей стене');
  assert.equal(f.elements.get('publish').disabled, true);
  assert.equal(f.elements.get('open-vk').hidden, false);
  assert.equal(f.elements.get('open-vk').href, 'https://vk.ru/app54874242#post=6311&experiment=http-repost');
  assert.equal(f.requests.length, 0); assert.equal(f.nativeCalls.length, 0);
});

test('the ordinary link still loads the video flow, without selecting the experiment', async (t) => {
  const f = await setup(t, { insideVK: false, hash: '#post=6311' });
  await f.waitFor(() => f.elements.get('status').dataset.state === 'error');
  assert.equal(f.elements.get('heading').textContent, 'Поделиться видео');
  assert.equal(f.elements.get('build-version').textContent, 'Версия 0.3.0');
  assert.equal(f.requests.length, 0);
});

test('the stored mode uses only VK Bridge and does not call the procedure before a click', async (t) => {
  const f = await setup(t, { hash: '#post=6311&experiment=stored-repost' });
  await f.waitFor(() => f.elements.get('status').dataset.state === 'ready');
  assert.equal(f.elements.get('build-version').textContent, 'Версия 0.5.0');
  assert.equal(f.nativeCalls.some(([, params]) => params?.method === 'execute.medonix_repost6311'), false);
  f.elements.get('publish').listeners.click();
  await f.waitFor(() => f.elements.get('status').dataset.state === 'published');
  assert.equal(f.requests.length, 0);
  assert.equal(f.nativeCalls.filter(([, params]) => params?.method === 'execute.medonix_repost6311').length, 1);
  assert.equal(f.nativeCalls.some(([, params]) => params?.method === 'wall.repost'), false);
});

test('an unregistered stored procedure shows the concrete owner action instead of success', async (t) => {
  const f = await setup(t, { hash: '#post=6311&experiment=stored-repost', storedError: 3 });
  await f.waitFor(() => f.elements.get('status').dataset.state === 'ready');
  f.elements.get('publish').listeners.click();
  await f.waitFor(() => f.elements.get('status').dataset.state === 'unconfirmed');
  assert.match(f.elements.get('status').textContent, /medonix_repost6311 версии 1/);
  assert.match(f.elements.get('diagnostic-code').textContent, /API_3/);
  assert.equal(f.elements.get('publish').disabled, true);
  assert.equal(f.requests.length, 0);
});
