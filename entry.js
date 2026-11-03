import { campaigns, defaultCampaign } from './campaigns.js';
import { selectCampaign } from './core.js?v=0.4.0';

export function entryRoute(hash) {
  if (typeof hash !== 'string' || hash.length > 250) throw new Error('INVALID_LINK');
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const experiments = params.getAll('experiment');
  if (experiments.length === 0) return { mode: 'video', campaignHash: hash };
  if (experiments.length !== 1 || experiments[0] !== 'http-repost') throw new Error('INVALID_LINK');
  params.delete('experiment');
  const campaignHash = `#${params}`;
  selectCampaign(campaignHash, campaigns, defaultCampaign);
  return { mode: 'http-repost', campaignHash };
}

async function start() {
  const route = entryRoute(location.hash);
  if (route.mode === 'video') { await import('./app.js?v=0.3.0'); return; }
  const [{ createVKHttpCaller }, { startRepostPage }] = await Promise.all([
    import('./vk-http.js?v=0.4.0'), import('./repost.js?v=0.4.0&manual=1'),
  ]);
  const campaign = selectCampaign(route.campaignHash, campaigns, defaultCampaign);
  document.title = 'Проверка настоящего репоста — МедОникс';
  document.getElementById('heading').textContent = 'Сделать репост';
  document.getElementById('publish').textContent = 'Сделать репост на моей стене';
  document.querySelector('.eyebrow').textContent = 'ТЕСТ НАСТОЯЩЕГО РЕПОСТА';
  document.querySelector('.intro').textContent = 'После нажатия сначала проверим исходную запись и наличие вашего репоста. Затем возможна одна отправка настоящего репоста.';
  document.querySelector('.video-icon').textContent = '↗';
  document.querySelector('.footnote').innerHTML = 'Тестируем прямое соединение с официальным API ВК.<br>Успешный мобильный репост этим способом ещё не подтверждён.<br><span id="build-version">Версия 0.4.0</span><br><a class="source" href="privacy.html">Как используются данные</a>';
  document.getElementById('open-vk').href = 'https://vk.ru/app54874242#post=6311&experiment=http-repost';
  await startRepostPage({ createCallAPI: (log) => createVKHttpCaller({ campaign, log }),
    campaignHash: route.campaignHash, version: '0.4.0', transport: 'https_api', expectedAppId: 54874242 });
}

if (new URL(import.meta.url).searchParams.get('manual') !== '1') {
  void start().catch(() => {
    const status = document.getElementById('status');
    status.textContent = 'Не удалось открыть этот режим приложения. Публикация не отправлялась. Закройте приложение и откройте ссылку заново.';
    status.dataset.state = 'error'; document.getElementById('publish').disabled = true;
  });
}
