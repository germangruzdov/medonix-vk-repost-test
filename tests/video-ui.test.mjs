import test from 'node:test';
import assert from 'node:assert/strict';

async function setup(t, { insideVK = true, missingVideo = false, unsupported = false, nativeError } = {}) {
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
    'diagnostic-output', 'source', 'card', 'open-vk']) {
    elements.set(id, { textContent: '', dataset: {}, hidden: true, disabled: true,
      listeners: {}, setAttribute() {}, addEventListener(name, listener) { this.listeners[name] = listener; } });
  }
  const calls = [];
  const video = { owner_id: -218885671, id: 456239373 };
  Object.assign(globalThis, {
    document: { getElementById: (id) => elements.get(id), querySelector: () => elements.get('card') },
    location: { search: '', hash: '' },
    window: { vkBridge: { isWebView: () => insideVK, isIframe: () => false, isEmbedded: () => false,
      supportsAsync: async () => !unsupported, send: async (method, params) => {
        const operation = params?.method ?? method;
        calls.push(operation);
        if (method === 'VKWebAppInit') return {};
        if (method === 'VKWebAppGetLaunchParams') return { vk_app_id: 54874242, vk_user_id: 123 };
        if (method === 'VKWebAppGetAuthToken') return { access_token: 'private-token', scope: 'wall' };
        if (operation === 'wall.getById') return { response: { items: [
          params.params.posts === '-218885671_6311'
            ? { owner_id: -218885671, id: 6311, attachments: missingVideo ? [] : [{ type: 'clip', clip: video }] }
            : { owner_id: 123, id: 456, attachments: [{ type: 'video', video }] },
        ] } };
        if (operation === 'video.get') return { response: { items: [video] } };
        if (operation === 'VKWebAppShowWallPostBox') {
          if (nativeError) throw nativeError;
          return { post_id: 456 };
        }
        throw new Error('Unexpected bridge method');
      },
    } },
  });
  await import(`../app.js?case=${encodeURIComponent(t.name)}`);
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.fail('UI did not reach the expected state');
  };
  return { elements, calls, waitFor };
}

test('the video UI prepares a clip, waits for a click and reports only verified publication', async (t) => {
  const f = await setup(t);
  await f.waitFor(() => f.elements.get('status').dataset.state === 'ready');
  const button = f.elements.get('publish');
  assert.equal(button.disabled, false);
  assert.equal(f.calls.includes('VKWebAppShowWallPostBox'), false);
  assert.equal(f.calls.includes('video.get'), true);
  assert.equal(f.elements.get('build-version').textContent, 'Версия 0.3.0');
  button.listeners.click();
  await f.waitFor(() => f.elements.get('status').dataset.state === 'published');
  assert.equal(button.disabled, true);
  assert.match(f.elements.get('status').textContent, /новую запись с выбранным видео/);
  assert.equal(f.calls.filter((method) => method === 'VKWebAppShowWallPostBox').length, 1);
  assert.equal(f.calls.some((method) => ['wall.post', 'wall.repost'].includes(method)), false);
});

test('outside VK the page shows the application link and performs no bridge calls', async (t) => {
  const f = await setup(t, { insideVK: false });
  await f.waitFor(() => f.elements.get('status').dataset.state === 'error');
  assert.equal(f.elements.get('publish').disabled, true);
  assert.equal(f.elements.get('open-vk').hidden, false);
  assert.equal(f.calls.length, 0);
});

test('a missing source video produces a safe diagnostic and never opens an empty editor', async (t) => {
  const f = await setup(t, { missingVideo: true });
  await f.waitFor(() => f.elements.get('status').dataset.state === 'error');
  assert.match(f.elements.get('diagnostic-code').textContent, /VIDEO_SOURCE \/ VIDEO_NOT_FOUND/);
  assert.equal(f.elements.get('publish').textContent, 'Повторить проверку');
  assert.equal(f.calls.includes('VKWebAppShowWallPostBox'), false);
  assert.equal(f.elements.get('diagnostic-output').textContent.includes('private-token'), false);
});

test('an unsupported native editor fails before requesting permissions or opening it', async (t) => {
  const f = await setup(t, { unsupported: true });
  await f.waitFor(() => f.elements.get('status').dataset.state === 'error');
  assert.equal(f.elements.get('publish').disabled, true);
  assert.match(f.elements.get('diagnostic-code').textContent, /VIDEO_INIT \/ UNSUPPORTED/);
  assert.equal(f.calls.includes('VKWebAppGetAuthToken'), false);
});

test('a client refusal in the native editor stays visible and disables repeat publication', async (t) => {
  const f = await setup(t, { nativeError: { error_type: 'client_error', error_data: {
    error_code: 11, error_reason: 'Access denied', request_params: ['private-token'],
  } } });
  await f.waitFor(() => f.elements.get('status').dataset.state === 'ready');
  f.elements.get('publish').listeners.click();
  await f.waitFor(() => f.elements.get('status').dataset.state === 'unconfirmed');
  assert.match(f.elements.get('diagnostic-code').textContent, /COMPOSER \/ CLIENT_11 \/ access denied/);
  assert.equal(f.elements.get('publish').disabled, true);
  assert.equal(f.calls.filter((method) => method === 'VKWebAppShowWallPostBox').length, 1);
  assert.equal(f.elements.get('diagnostic-output').textContent.includes('private-token'), false);
});
