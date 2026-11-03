import { campaigns, defaultCampaign } from './campaigns.js';
import { selectCampaign, diagnosticFields, diagnosticLabel, withTimeout, ShareError } from './core.js?v=0.3.0';
import { createVideoPublisher } from './video-core.js?v=0.3.0';

const VERSION = '0.3.0';
const status = document.getElementById('status');
const publish = document.getElementById('publish');
const diagnosticCode = document.getElementById('diagnostic-code');
const panel = document.getElementById('diagnostics');
const debug = new URLSearchParams(location.search).get('debug') === '1';
const records = [];
let lastDiagnostic;
panel.hidden = !debug;
const version = document.getElementById('build-version');
if (version) version.textContent = `Версия ${VERSION}`;

function log(level, event, fields = {}) {
  const record = { time: new Date().toISOString(), level, event, ...fields };
  records.push(record);
  if (records.length > 30) records.shift();
  if (debug) console.debug('[vk-video-share]', record);
  if (!panel.hidden) document.getElementById('diagnostic-output').textContent = records.map((item) => JSON.stringify(item)).join('\n');
}
function reportDiagnostic(diagnostic) {
  lastDiagnostic = diagnostic;
  const reason = [diagnostic.clientReason, diagnostic.clientDescription].filter(Boolean).join(' / ');
  diagnosticCode.textContent = `Код проверки: ${VERSION} / ${diagnostic.phase} / ${diagnosticLabel(diagnostic)}${reason ? ` / ${reason}` : ''}`;
  diagnosticCode.hidden = false;
  panel.hidden = false;
  log('warning', 'video.diagnostic', diagnostic);
}
const messages = {
  authorizing: 'Ожидаем разрешение ВК для проверки видео…',
  preparing: 'Проверяем видео исходной записи…',
  ready: 'Видео найдено. В окне ВК проверьте вложение и подтвердите публикацию.',
  opening: 'Открываем окно публикации ВКонтакте…',
  waiting: 'Завершите публикацию в открытом окне ВК или закройте его. Повторно окно не открываем.',
  verifying: 'Проверяем, что опубликованная запись содержит выбранное видео…',
  published: 'ВК подтвердил новую запись с выбранным видео на вашей стене.',
  unconfirmed: 'Результат публикации не подтверждён. Проверьте свою стену. Повторно окно не открываем.',
  not_published: 'Окно публикации закрыто. Вы можете открыть его ещё раз.',
  error: 'Не удалось проверить видео. Окно публикации не открывалось.',
};
function showState(state) {
  if (state === 'authorizing') {
    lastDiagnostic = undefined; diagnosticCode.hidden = true; panel.hidden = !debug;
  }
  status.textContent = messages[state] ?? messages.error;
  if (state === 'error') {
    if (lastDiagnostic?.code === 'VIDEO_SHARING_UNAVAILABLE') {
      status.textContent = 'По данным ВК, публикация этого видео недоступна. Окно публикации не открывалось.';
    } else if (['CLIP_VIDEO_NOT_CONFIRMED', 'VIDEO_NOT_FOUND'].includes(lastDiagnostic?.code)
      || lastDiagnostic?.phase === 'CLIP_VIDEO_CHECK') {
      status.textContent = 'ВК не подтвердил, что этот клип доступен как видеовложение. Для этого способа потребуется обычная видеозапись. Публикация не отправлялась.';
    } else if (lastDiagnostic?.code === 'WALL_PERMISSION_MISSING') {
      status.textContent = 'ВК не подтвердил разрешение для проверки записи. Окно публикации не открывалось.';
    }
  }
  status.dataset.state = state;
  publish.disabled = !['ready', 'not_published', 'error'].includes(state);
  publish.textContent = state === 'published' ? 'Видео опубликовано'
    : state === 'error' ? 'Повторить проверку' : 'Опубликовать видео на моей стене';
  document.querySelector('.card').setAttribute('aria-busy', String(['authorizing', 'preparing', 'opening', 'waiting', 'verifying'].includes(state)));
}
async function start() {
  const campaign = selectCampaign(location.hash, campaigns, defaultCampaign);
  document.getElementById('source').href = campaign.sourceUrl;
  const bridge = window.vkBridge;
  const insideVK = bridge && (bridge.isWebView() || bridge.isIframe() || bridge.isEmbedded());
  log('info', 'video.start', { version: VERSION, campaign: campaign.id, insideVK: Boolean(insideVK) });
  if (!insideVK) {
    status.textContent = 'Откройте приложение внутри ВКонтакте, чтобы подготовить запись с видео.';
    status.dataset.state = 'error';
    document.getElementById('open-vk').hidden = false;
    return;
  }
  await withTimeout(bridge.send('VKWebAppInit', {}), 12000);
  if (!await withTimeout(bridge.supportsAsync('VKWebAppShowWallPostBox'), 12000)) throw new ShareError('UNSUPPORTED');
  const launch = await withTimeout(bridge.send('VKWebAppGetLaunchParams', {}), 12000);
  const publisher = createVideoPublisher({ bridge, appId: launch?.vk_app_id, userId: launch?.vk_user_id,
    campaign, onState: showState, onDiagnostic: reportDiagnostic, log });
  publish.addEventListener('click', () => {
    if (publisher.state === 'error') void publisher.prepare();
    else void publisher.open();
  });
  await publisher.prepare();
}
void start().catch((error) => {
  reportDiagnostic({ phase: 'VIDEO_INIT', ...diagnosticFields(error) });
  status.textContent = 'Не удалось подготовить приложение ВК. Публикация не отправлялась. Закройте приложение и попробуйте открыть снова.';
  status.dataset.state = 'error'; publish.disabled = true;
});
