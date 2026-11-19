# fsociety NET — расширение для браузера (Chrome, Яндекс Браузер)

Manifest V3, Chromium 108+. Только по подписке: бесплатных серверов нет.

- `extension/` — само расширение. Вход как в приложениях (email/логин + пароль или 16-значный код),
  выбор сервера, кнопка подключения; вкладки «Настройки» (язык, защита WebRTC, автовключение, диагностика),
  Telegram (пока заглушка), «Поддержка» (ссылки на /ticket/ и /faq/ сайта).
- `server/` — HTTPS-прокси для сервера (Python 3.10+, только stdlib) и systemd-юнит.
- `tools/make_icons.ps1` — перерисовать иконки.

## Как это работает
1. Расширение запрашивает `GET /api/vpn/browser-proxy` (Bearer-токен). API отдаёт список прокси из
   `api/browser_proxies.json` (на Финке, не в git) и пароль `<exp>.<hmac>`, HMAC-SHA256(BROWSER_PROXY_KEY,
   "<user_id>|<exp>"). Пароль живёт 12 ч, расширение обновляет его само.
2. `chrome.proxy`: `fixed_servers`, схема `https` (TLS до прокси, сайты внутри — свой TLS). Пароль отдаётся
   через `webRequest.onAuthRequired`.
3. Прокси на сервере проверяет HMAC сам, без БД. Логов пользователей и сайтов нет. Локальные адреса и SMTP закрыты.

## Установка
Скачайте `fsociety-net-extension.zip` с https://fsociety-vpn.org/download или из
[релизов](https://github.com/ArtemK342/vpn-browser-extension/releases/latest), распакуйте в постоянную папку,
затем chrome://extensions (browser://extensions в Яндексе) → «Режим разработчика» → «Загрузить распакованное».

## Установка из исходников
chrome://extensions (или browser://extensions в Яндексе) → «Режим разработчика» → «Загрузить распакованное»
→ папка `extension`.

## Предпросмотр окна без расширения
`.claude/launch.json` → ext-popup, затем `http://localhost:8766/popup.html?demo=guest|free|none|paid|on`.

## Сервер
- `/opt/fsociety-browser-proxy/fsociety_browser_proxy.py`, юнит `fsociety-browser-proxy@<домен>.service`
  (`%i` = домен сертификата Let's Encrypt).
- `/etc/fsociety-browser-proxy.env` (600 root): `BROWSER_PROXY_KEY=<тот же, что в api/.env>`, `PORT=…`,
  `CERT=/run/credentials/fsociety-browser-proxy@<домен>.service/cert`, `KEY=…/key`.
- Firewall: открыть PORT/tcp.
- Финка: `api/.env` → `BROWSER_PROXY_KEY`; `api/browser_proxies.json` →
  `[{"id":"de","name":"Германия","country":"DE","host":"<домен>","port":<PORT>}]`.
