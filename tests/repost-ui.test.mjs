import test from 'node:test';
import assert from 'node:assert/strict';

test('the UI shows client error type and a safe explanation after one write attempt', async (t) => {
  const previous = Object.fromEntries(['document', 'window', 'location'].map((key) => [key,
    Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const elements = new Map();
  for (const id of ['status', 'publish', 'diagnostic-code', 'diagnostics', 'build-version',
    'diagnostic-output', 'source', 'card']) {
    elements.set(id, { textContent: '', dataset: {}, hidden: true, disabled: true,
      listeners: {}, setAttribute() {}, addEventListener(name, listener) { this.listeners[name] = listener; } });
  }
  const calls = [];
  Object.assign(globalThis, {
    document: { getElementById: (id) => elements.get(id), querySelector: () => elements.get('card') },
    location: { search: '', hash: '' },
    window: { vkBridge: { isWebView: () => true, send: async (method, params) => {
      calls.push(params?.method ?? method);
      if (method === 'VKWebAppInit') return {};
      if (method === 'VKWebAppGetLaunchParams') return { vk_app_id: 54874242 };
      if (method === 'VKWebAppGetAuthToken') return { access_token: 'private-token', scope: 'wall' };
      if (params.method === 'wall.getById') return { response: { items: [
        { owner_id: -218885671, id: 6311, reposts: { user_reposted: 0 } },
      ] } };
      throw { error_type: 'client_error', error_data: { error_code: 11,
        error_reason: 'API method is not allowed', error_description: 'private-token' } };
    } } },
  });
  await import('../repost.js');
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.fail('UI did not reach the expected state');
  };
  const button = elements.get('publish');
  await waitFor(() => button.listeners.click);
  assert.equal(button.disabled, false);
  assert.equal(calls.includes('wall.repost'), false);
  button.listeners.click();
  await waitFor(() => elements.get('status').dataset.state === 'unconfirmed');
  assert.equal(button.disabled, true);
  const diagnostic = elements.get('diagnostic-code');
  assert.equal(diagnostic.hidden, false);
  assert.match(diagnostic.textContent, /0\.2\.3 \/ REPOST_REQUEST \/ CLIENT_11/);
  assert.match(diagnostic.textContent, /api method is not allowed/);
  assert.equal(diagnostic.textContent.includes('private-token'), false);
  assert.match(elements.get('status').textContent, /Клиент ВК вернул ошибку/);
  assert.equal(calls.filter((method) => method === 'wall.repost').length, 1);
  button.listeners.click();
  await Promise.resolve();
  assert.equal(calls.filter((method) => method === 'wall.repost').length, 1);
});
