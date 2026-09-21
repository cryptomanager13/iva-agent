(() => {
  'use strict';
  const key = 'iva-analytics-consent-v1';
  const ru = document.documentElement.lang === 'ru';
  const ui = document.createElement('div');
  ui.innerHTML = `<button type="button" data-consent-settings hidden class="iva-privacy-settings">${ru ? 'Приватность' : 'Privacy settings'}</button><aside class="iva-consent" data-consent-banner aria-labelledby="iva-consent-title" hidden><h2 id="iva-consent-title">${ru ? 'Статистика посещений' : 'Visit statistics'}</h2><p>${ru ? 'Разрешить Google Analytics для статистики посещений? Счётчик загружается только после согласия.' : 'Allow Google Analytics to measure visits? The tracker loads only after you agree.'} <a href="/privacy/">${ru ? 'Подробнее' : 'Details'}</a></p><div><button type="button" data-consent="denied">${ru ? 'Отказаться' : 'Decline'}</button><button type="button" data-consent="granted">${ru ? 'Разрешить' : 'Allow analytics'}</button></div></aside>`;
  document.body.append(ui);
  const banner = ui.querySelector('[data-consent-banner]');
  if (!banner) return;
  let choice = null;
  let loaded = false;
  let returnFocus = null;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved?.expires > Date.now() && ['granted', 'denied'].includes(saved.value)) choice = saved.value;
  } catch { choice = null; }
  const start = () => {
    if (choice !== 'granted' || loaded || location.hostname !== 'iva-agent.com' || navigator.globalPrivacyControl) return;
    loaded = true;
    const id = 'G-9C8EPEEBPP';
    window['ga-disable-' + id] = false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', {analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied'});
    window.gtag('js', new Date());
    let referrer = '';
    try { const url = new URL(document.referrer); referrer = url.origin + url.pathname; } catch {}
    window.gtag('config', id, {page_location: location.origin + location.pathname, page_referrer: referrer, allow_google_signals: false, allow_ad_personalization_signals: false});
    const google = document.createElement('script');
    google.async = true;
    google.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
    document.head.append(google);

  };
  for (const button of document.querySelectorAll('[data-consent-settings]')) {
    button.hidden = false;
    button.addEventListener('click', () => {
      returnFocus = button;
      banner.hidden = false;
      banner.querySelector('button').focus();
    });
  }
  for (const button of banner.querySelectorAll('[data-consent]')) button.addEventListener('click', () => {
    choice = button.dataset.consent;
    try { localStorage.setItem(key, JSON.stringify({value: choice, expires: Date.now() + 365 * 86400000})); }
    catch { banner.dataset.persistence = 'current-page'; }
    banner.hidden = true;
    returnFocus?.focus();
    if (choice === 'denied') { window['ga-disable-G-9C8EPEEBPP'] = true; window.gtag?.('consent', 'update', {analytics_storage: 'denied'}); }
    else if (loaded) { window['ga-disable-G-9C8EPEEBPP'] = false; window.gtag?.('consent', 'update', {analytics_storage: 'granted'}); }
    start();
  });
  window.addEventListener('storage', event => { if (event.key === key) location.reload(); });
  banner.hidden = choice !== null || !!navigator.globalPrivacyControl;
  start();
})();
