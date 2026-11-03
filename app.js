import { campaigns, defaultCampaign } from './campaigns.js';
import { selectCampaign, createPublisher, diagnosticFields, withTimeout, ShareError } from './core.js';

const status = document.getElementById('status');
const publish = document.getElementById('publish');
const debug = new URLSearchParams(location.search).get('debug') === '1';
const records = [];
document.getElementById('diagnostics').hidden = !debug;

function log(level, event, fields = {}) {
  const record = { time: new Date().toISOString(), level, event, ...fields };
  records.push(record);
  if (records.length > 30) records.shift();
  if (debug) {
    console.debug('[vk-video-share]', record);
    document.getElementById('diagnostic-output').textContent = records.map((item) => JSON.stringify(item)).join('\n');
  }
}

const messages = {
  ready: 'Видео подготовлено. Откройте редактор и подтвердите публикацию.',
  opening: 'Открываем редактор ВКонтакте…',
  waiting: 'Если редактор открыт, завершите публикацию или закройте его. Повторно окно не открываем.',
  published: 'ВКонтакте подтвердил публикацию записи на вашей стене.',
  unconfirmed: 'ВКонтакте не подтвердил результат. Проверьте свою стену перед повторной публикацией.',
  not_published: 'Публикация не подтверждена: окно могло быть закрыто или ВК отклонил вложение. Перед повторной попыткой проверьте свою стену.',
};
function showState(state) {
  status.textContent = messages[state] ?? messages.not_published;
  status.dataset.state = state;
  publish.disabled = !['ready', 'not_published'].includes(state);
  publish.textContent = state === 'published' ? 'Опубликовано' : state === 'not_published' ? 'Открыть ещё раз' : 'Открыть публикацию';
  document.querySelector('.card').setAttribute('aria-busy', String(['opening', 'waiting'].includes(state)));
}

async function start() {
  const started = performance.now();
  const campaign = selectCampaign(location.hash, campaigns, defaultCampaign);
  document.getElementById('source').href = campaign.sourceUrl;
  const bridge = window.vkBridge;
  const insideVK = bridge && (bridge.isWebView() || bridge.isIframe() || bridge.isEmbedded());
  log('info', 'app.start', { campaign: campaign.id, insideVK: Boolean(insideVK), mediaKind: campaign.kind });
  if (!insideVK) {
    status.textContent = 'Эта страница работает как мини-приложение внутри ВКонтакте. Откройте его по ссылке ВК.';
    status.dataset.state = 'error';
    document.getElementById('setup-link').hidden = false;
    return;
  }
  await withTimeout(bridge.send('VKWebAppInit', {}), 12000);
  const supported = await withTimeout(bridge.supportsAsync('VKWebAppShowWallPostBox'), 12000);
  if (!supported) throw new ShareError('UNSUPPORTED');
  log('info', 'app.ready', { elapsedMs: Math.round(performance.now() - started) });
  const publisher = createPublisher({ bridge, campaign, onState: showState, log });
  publish.addEventListener('click', () => { void publisher.open(); });
  showState('ready');
  // Only the native editor opens automatically. Publication always requires
  // the person's confirmation in VK's own UI. There is no wall.post request.
  void publisher.open();
}

void start().catch((error) => {
  log('error', 'app.init_failed', diagnosticFields(error));
  status.textContent = error instanceof ShareError && ['INVALID_LINK', 'UNKNOWN_CAMPAIGN'].includes(error.code)
    ? 'Ссылка на публикацию неверна. Попросите отправителя прислать актуальную ссылку.'
    : 'Не удалось подготовить редактор ВК. Закройте мини-приложение и попробуйте открыть его снова.';
  status.dataset.state = 'error';
  publish.disabled = true;
});
