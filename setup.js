import { buildMiniAppLink } from './core.js';
import { defaultCampaign } from './campaigns.js';

const form = document.getElementById('setup-form');
const input = document.getElementById('app-id');
const result = document.getElementById('result-link');
const status = document.getElementById('setup-status');
const copy = document.getElementById('copy-link');
form.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const link = buildMiniAppLink(input.value.trim(), defaultCampaign);
    input.removeAttribute('aria-invalid');
    result.textContent = link; result.href = link; result.hidden = false;
    copy.hidden = false;
    status.textContent = 'Ссылка сформирована. Сначала проверьте её на телефоне после подключения хостинга к приложению.';
  } catch {
    input.setAttribute('aria-invalid', 'true'); input.focus();
    result.hidden = true; copy.hidden = true;
    status.textContent = 'Введите числовой ID зарегистрированного приложения ВК.';
  }
});
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(result.href);
    status.textContent = 'Ссылка скопирована.';
  } catch {
    status.textContent = 'Браузер не разрешил копирование. Выделите и скопируйте ссылку выше вручную.';
  }
});
