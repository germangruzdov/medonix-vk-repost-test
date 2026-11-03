import { campaigns, defaultCampaign } from './campaigns.js';
import { selectCampaign, positiveId, diagnosticFields, withTimeout } from './core.js';
import { createReposter } from './repost-core.js';

const status = document.getElementById('status');
const button = document.getElementById('publish');
const debug = new URLSearchParams(location.search).get('debug') === '1';
const records = [];
document.getElementById('diagnostics').hidden = !debug;
function log(level, event, fields = {}) {
  records.push({ time: new Date().toISOString(), level, event, ...fields });
  if (records.length > 30) records.shift();
  if (debug) {
    console.debug('[vk-repost]', records.at(-1));
    document.getElementById('diagnostic-output').textContent = records.map((r) => JSON.stringify(r)).join('\n');
  }
}
const messages = {
  ready: 'Будет опубликован репост исходной записи. Нажмите кнопку для подтверждения.',
  authorizing: 'Ожидаем разрешение в окне ВК…',
  checking: 'Проверяем доступность записи и наличие вашего репоста…',
  publishing: 'Отправляем репост. Не закрывайте приложение…',
  published: 'ВКонтакте подтвердил репост на вашу стену.',
  already: 'По данным ВК, вы уже сделали репост этой записи. Повторно его не отправляем.',
  denied: 'Не удалось получить доступ или проверить исходную запись. Репост не отправлялся. Если отказали в разрешении, можно попробовать ещё раз.',
  unconfirmed: 'ВК не подтвердил результат запроса. Проверьте свою стену. Повторно репост автоматически не отправляем.',
};
function render(state) {
  status.textContent = messages[state];
  status.dataset.state = state === 'denied' ? 'error' : state;
  button.disabled = !['ready', 'denied'].includes(state);
  button.textContent = state === 'published' ? 'Репост опубликован' : 'Сделать репост на моей стене';
  document.querySelector('.card').setAttribute('aria-busy', String(['authorizing', 'checking', 'publishing'].includes(state)));
}
async function start() {
  const campaign = selectCampaign(location.hash, campaigns, defaultCampaign);
  document.getElementById('source').href = campaign.sourceUrl;
  const bridge = window.vkBridge;
  const insideVK = bridge && (bridge.isWebView() || bridge.isIframe() || bridge.isEmbedded());
  log('info', 'repost.start', { campaign: campaign.id, insideVK: Boolean(insideVK) });
  if (!insideVK) {
    status.textContent = 'Страница репоста должна открываться внутри зарегистрированного мини-приложения ВК. Пока приложение не подключено, публикация недоступна.';
    status.dataset.state = 'error'; return;
  }
  await withTimeout(bridge.send('VKWebAppInit', {}), 12000);
  const launch = await withTimeout(bridge.send('VKWebAppGetLaunchParams', {}), 12000);
  const appId = positiveId(launch?.vk_app_id);
  const reposter = createReposter({ bridge, appId, campaign, onState: render, log });
  button.addEventListener('click', () => { void reposter.run(); });
  render('ready');
}
void start().catch((error) => {
  log('error', 'repost.init_failed', diagnosticFields(error));
  status.textContent = 'Не удалось подготовить приложение ВК. Репост не отправлялся. Закройте приложение и попробуйте открыть снова.';
  status.dataset.state = 'error'; button.disabled = true;
});
