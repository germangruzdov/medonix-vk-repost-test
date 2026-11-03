import { campaigns, defaultCampaign } from './campaigns.js';
import { selectCampaign, positiveId, diagnosticFields, diagnosticLabel, withTimeout, ShareError } from './core.js?v=0.4.0';
import { createReposter } from './repost-core.js?v=0.4.0';

export function startRepostPage({ callAPI, createCallAPI, version = '0.2.3', campaignHash = location.hash,
  transport = 'bridge', expectedAppId } = {}) {
  const VERSION = version;
  const status = document.getElementById('status');
  const button = document.getElementById('publish');
  let diagnosticCode = document.getElementById('diagnostic-code');
  // A WebView can briefly combine cached HTML with the current script.
  if (!diagnosticCode) {
    diagnosticCode = document.createElement('p');
    diagnosticCode.id = 'diagnostic-code';
    diagnosticCode.className = 'diagnostic-code';
    diagnosticCode.hidden = true;
    diagnosticCode.setAttribute('role', 'note');
    status.insertAdjacentElement('afterend', diagnosticCode);
  }
  const diagnosticPanel = document.getElementById('diagnostics');
  const debug = new URLSearchParams(location.search).get('debug') === '1';
  const records = [];
  let lastDiagnostic;
  diagnosticPanel.hidden = !debug;
  const buildVersion = document.getElementById('build-version');
  if (buildVersion) buildVersion.textContent = `Версия ${VERSION}`;
  function refreshDiagnosticPanel() {
    if (!diagnosticPanel.hidden) {
      document.getElementById('diagnostic-output').textContent = records.map((r) => JSON.stringify(r)).join('\n');
    }
  }
  function log(level, event, fields = {}) {
    records.push({ time: new Date().toISOString(), level, event, ...fields });
    if (records.length > 30) records.shift();
    if (debug) {
      console.debug('[vk-repost]', records.at(-1));
    }
    refreshDiagnosticPanel();
  }
  function reportDiagnostic(diagnostic) {
    lastDiagnostic = diagnostic;
    const code = diagnosticLabel(diagnostic);
    const explanation = [diagnostic.clientReason, diagnostic.clientDescription].filter(Boolean).join(' / ');
    diagnosticCode.textContent = `Код проверки: ${VERSION} / ${diagnostic.phase} / ${code}${explanation ? ` / ${explanation}` : ''}`;
    diagnosticCode.hidden = false;
    diagnosticPanel.hidden = false;
    refreshDiagnosticPanel();
  }
  const messages = {
    ready: 'Нажмите кнопку, чтобы запросить репост исходной записи. Результат будет проверен по ответу ВК.',
    authorizing: 'Ожидаем разрешение в окне ВК…',
    checking: 'Проверяем доступность записи и наличие вашего репоста…',
    publishing: 'Отправляем репост. Не закрывайте приложение…',
    published: 'ВКонтакте подтвердил репост на вашу стену.',
    already: 'По данным ВК, вы уже сделали репост этой записи. Повторно его не отправляем.',
    denied: 'Не удалось выполнить проверку в ВК. Репост не отправлялся. Код ниже поможет установить причину.',
    unconfirmed: 'ВК не подтвердил результат запроса. Проверьте свою стену. Повторно репост автоматически не отправляем.',
  };
  function render(state) {
    if (state === 'authorizing') {
      lastDiagnostic = undefined;
      diagnosticCode.hidden = true;
      diagnosticPanel.hidden = !debug;
    }
    status.textContent = messages[state];
    if (state === 'unconfirmed' && lastDiagnostic?.type === 'client_error') {
      status.textContent = 'Клиент ВК вернул ошибку при отправке репоста. Разрешение на стену уже получено. Результат публикации не подтверждён; проверьте свою стену. Повторно запрос не отправляем.';
    }
    if (state === 'unconfirmed' && lastDiagnostic?.type === 'api_error') {
      status.textContent = [15, 20].includes(lastDiagnostic.bridgeCode)
        ? 'API ВК отказал в репосте для выданного токена. Повторно запрос не отправляем.'
        : 'API ВК вернул ошибку при отправке репоста. Проверьте свою стену. Повторно запрос не отправляем.';
    }
    if (state === 'denied') {
      if (lastDiagnostic?.code === 'WALL_PERMISSION_MISSING') {
        status.textContent = 'ВК не подтвердил право доступа к стене. Это отдельное право, даже если окно разрешения уже было принято. Репост не отправлялся.';
      } else if (lastDiagnostic?.code === 'REPOST_STATUS_UNKNOWN') {
        status.textContent = 'ВК не сообщил, есть ли у вас репост этой записи. Проверка остановлена до отправки репоста.';
      } else if (['HTTP_UNAVAILABLE', 'HTTP_TIMEOUT'].includes(lastDiagnostic?.code)) {
        status.textContent = 'Не удалось установить прямое соединение с API ВК: возможны ошибка сети или ограничение браузера. Репост не отправлялся.';
      } else if (lastDiagnostic?.phase?.startsWith('SOURCE')) {
        status.textContent = 'Не удалось проверить исходную запись через API ВК. Репост не отправлялся.';
      }
    }
    status.dataset.state = state === 'denied' ? 'error' : state;
    button.disabled = !['ready', 'denied'].includes(state);
    button.textContent = state === 'published' ? 'Репост опубликован' : 'Сделать репост на моей стене';
    document.querySelector('.card').setAttribute('aria-busy', String(['authorizing', 'checking', 'publishing'].includes(state)));
  }
  async function start() {
    const campaign = selectCampaign(campaignHash, campaigns, defaultCampaign);
    document.getElementById('source').href = campaign.sourceUrl;
    const bridge = window.vkBridge;
    const insideVK = bridge && (bridge.isWebView() || bridge.isIframe() || bridge.isEmbedded());
    log('info', 'repost.start', { version: VERSION, campaign: campaign.id, transport, insideVK: Boolean(insideVK) });
    if (!insideVK) {
      status.textContent = 'Этот режим работает внутри приложения ВКонтакте. Откройте мини-приложение ВК по тестовой ссылке.';
      status.dataset.state = 'error';
      const openVK = document.getElementById('open-vk');
      if (openVK) openVK.hidden = false;
      return;
    }
    await withTimeout(bridge.send('VKWebAppInit', {}), 12000);
    const launch = await withTimeout(bridge.send('VKWebAppGetLaunchParams', {}), 12000);
    const appId = positiveId(launch?.vk_app_id);
    if (expectedAppId !== undefined && appId !== positiveId(expectedAppId)) throw new ShareError('WRONG_APP');
    const reposter = createReposter({ bridge, appId, campaign, callAPI: callAPI ?? createCallAPI?.(log),
      onState: render, onDiagnostic: reportDiagnostic, log });
    button.addEventListener('click', () => { void reposter.run(); });
    render('ready');
  }
  return start().catch((error) => {
    reportDiagnostic({ phase: 'INIT', ...diagnosticFields(error) });
    log('error', 'repost.init_failed', diagnosticFields(error));
    status.textContent = 'Не удалось подготовить приложение ВК. Репост не отправлялся. Закройте приложение и попробуйте открыть снова.';
    status.dataset.state = 'error'; button.disabled = true;
  });
}

if (new URL(import.meta.url).searchParams.get('manual') !== '1') void startRepostPage();
