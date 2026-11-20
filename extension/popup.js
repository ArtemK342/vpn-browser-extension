// Popup: renders the state the service worker keeps; every action goes through it (background.js).
const SITE = "https://fsociety-vpn.org";

const T = {
  login: ["Войти", "Sign in"],
  logout_title: ["Выйти из аккаунта", "Sign out"],
  logout_q: ["Выйти? Нажмите ещё раз", "Sign out? Click again"],
  code_account: ["Аккаунт по коду", "Code account"],
  off_title: ["Защита отключена", "Protection is off"],
  off_sub: ["Соединение идёт напрямую: сайты видят ваш IP и страну.", "Your connection is direct: sites see your IP and country."],
  on_title: ["Защита включена", "Protection is on"],
  on_sub: ["Трафик браузера идёт через сервер «{s}». Другие программы — напрямую.", "Browser traffic goes through the «{s}» server. Other apps are not affected."],
  busy: ["Подключение…", "Connecting…"],
  enable: ["Включить VPN", "Turn on VPN"],
  disable: ["Выключить", "Turn off"],
  login_to_enable: ["Войдите, чтобы включить VPN", "Sign in to turn on the VPN"],
  guest_sub: ["Расширение работает с аккаунтом fsociety NET и подпиской.", "The extension works with a fsociety NET account and a subscription."],
  need_sub: ["Расширение работает по подписке. Оформите её в личном кабинете, затем нажмите", "The extension requires a subscription. Get one in your account, then press"],
  buy: ["Оформить подписку", "Get a subscription"],
  refresh: ["Обновить", "Refresh"],
  no_servers: ["Серверы для браузера скоро появятся.", "Browser servers are coming soon."],
  other_ext: ["Прокси браузера сейчас управляет другое расширение или политика. Отключите его, чтобы fsociety NET заработал.", "Another extension or a policy controls the browser proxy. Disable it so fsociety NET can work."],
  server: ["Сервер", "Server"],
  back_tip: ["Назад", "Back"],
  login_title: ["Вход в fsociety NET", "Sign in to fsociety NET"],
  tab_pass: ["Email или логин", "Email or login"],
  tab_code: ["Код аккаунта", "Account code"],
  user_ph: ["Email или логин", "Email or login"],
  pass_ph: ["Пароль", "Password"],
  code_ph: ["16 цифр", "16 digits"],
  login_btn: ["Войти", "Sign in"],
  no_account: ["Нет аккаунта?", "No account?"],
  register: ["Регистрация на сайте", "Sign up on the site"],
  sw_on: ["ВКЛ", "ON"],
  sw_off: ["ВЫКЛ", "OFF"],
  nav_home: ["Главная", "Home"],
  nav_settings: ["Настройки", "Settings"],
  nav_tg: ["Telegram — скоро", "Telegram — soon"],
  nav_support: ["Поддержка", "Support"],
  lang: ["Язык", "Language"],
  lang_auto: ["Авто", "Auto"],
  webrtc: ["Защита от утечки IP через WebRTC", "Block IP leaks via WebRTC"],
  webrtc_hint: ["Пока VPN включён, звонки и видеочаты в браузере не раскроют ваш настоящий IP.", "While the VPN is on, in-browser calls and video chats won't reveal your real IP."],
  autostart: ["Включать при запуске браузера", "Turn on when the browser starts"],
  autostart_hint: ["Если VPN был включён, когда вы закрыли браузер.", "If the VPN was on when you closed the browser."],
  diag: ["Диагностика", "Diagnostics"],
  diag_run: ["Проверяю…", "Checking…"],
  support_title: ["Поддержка", "Support"],
  support_text: ["Что-то не работает или есть вопрос? Напишите нам — ответим на сайте и на почту.", "Something isn't working or have a question? Write to us — we reply on the site and by email."],
  support_btn: ["Написать в поддержку", "Contact support"],
  faq_btn: ["Частые вопросы", "FAQ"],
  official: ["Официальный сайт — только fsociety-vpn.org. Похожие сервисы к нам отношения не имеют.", "The only official site is fsociety-vpn.org. Look-alike services are not related to us."],
  err_network: ["Нет связи с сервером fsociety. Проверьте интернет.", "Can't reach fsociety. Check your connection."],
  err_unauthorized: ["Неверный логин или пароль.", "Wrong login or password."],
  err_generic: ["Что-то пошло не так. Попробуйте ещё раз.", "Something went wrong. Please try again."],
  expired: ["Подписка закончилась — VPN выключен.", "Your subscription has ended — the VPN is off."],
};
let ru = !(navigator.language || "ru").toLowerCase().startsWith("en");
const t = (k, vars = {}) => (T[k] ? T[k][ru ? 0 : 1] : k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? "");

const $ = (id) => document.getElementById(id);
const inExtension = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);
const send = inExtension
  ? (type, data = {}) => new Promise((res) => chrome.runtime.sendMessage({ type, ...data }, (r) => res(r || { ok: false })))
  : demoSend;   // popup.html opened as a plain page (design preview): ?demo=guest|free|paid|on|none

function demoSend(type) {
  const mode = new URLSearchParams(location.search).get("demo") || "guest";
  const px = [{ id: "fi", name: "Финляндия", country: "FI" }, { id: "de", name: "Германия", country: "DE" }];
  const acc = { label: "12130ar@gmail.com", plan: "month" };
  const d = {
    guest: { loggedIn: false, proxies: [], enabled: false },
    free: { loggedIn: true, account: { ...acc, plan: "free" }, proxies: [], enabled: false },
    none: { loggedIn: true, account: acc, proxies: [], enabled: false },
    paid: { loggedIn: true, account: acc, proxies: px, enabled: false, control: "controllable_by_this_extension" },
    on: { loggedIn: true, account: acc, proxies: px, enabled: true, selected: "de", control: "controlled_by_this_extension" },
  }[mode];
  if (type === "state") return Promise.resolve({ ok: true, data: { ...d, settings: { lang: "auto", webrtc: true, autostart: true } } });
  if (type === "diag") return Promise.resolve({ ok: true, data: ["demo"] });
  return Promise.resolve({ ok: true });
}

let state = null;
let busy = false;
let view = "home";

function errText(r) {
  if (r.code === "network") return t("err_network");
  if (r.status === 401 && !r.message) return t("err_unauthorized");
  if (r.message) return r.message;
  return t("err_generic");
}

const PRIVILEGED = ["tester", "developer", "admin", "superadmin"];
const canUse = (a) => a && (a.plan !== "free" || PRIVILEGED.includes(a.role));
const proxyName = (p) => p ? (p.name || p.country || p.id) : "";
let selectedId = null;

// "DE" → 🇩🇪 (regional indicators; drawn by the Twemoji flags font)
const flag = (cc) => /^[A-Za-z]{2}$/.test(cc || "") ? [...cc.toUpperCase()].map((c) => String.fromCodePoint(0x1F1A5 + c.charCodeAt(0))).join("") : "🌐";

// Account label is masked (shoulder surfing, screenshots): 12•••@gmail.com, lo•••
function mask(label) {
  if (!label) return t("code_account");
  const at = label.indexOf("@");
  const name = at > 0 ? label.slice(0, at) : label;
  const shown = name.slice(0, Math.min(2, Math.max(1, name.length - 1)));
  return shown + "•••" + (at > 0 ? label.slice(at) : "");
}

// ── Views ──
function show(v) {
  view = v;
  for (const id of ["home", "settings", "support", "login"]) $("view-" + id).hidden = id !== v;
  for (const b of document.querySelectorAll(".nav[data-view]")) b.classList.toggle("active", b.dataset.view === v);
  $("navLabel").textContent = v === "login" ? "" : t("nav_" + v);
  if (v === "login") {
    $("loginError").hidden = true;
    setTimeout(() => ($("formPass").hidden ? $("code") : $("user")).focus(), 0);
  }
}

function texts() {
  document.documentElement.lang = ru ? "ru" : "en";
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll("[data-tip]")) { el.title = t(el.dataset.tip); el.setAttribute("aria-label", el.title); }
  $("user").placeholder = t("user_ph"); $("pass").placeholder = t("pass_ph"); $("code").placeholder = t("code_ph");
  $("navLabel").textContent = view === "login" ? "" : t("nav_" + view);
}

function render() {
  const s = state;
  const acc = $("account");
  if (!acc.dataset.armed) {
    acc.textContent = s.loggedIn ? mask(s.account && s.account.label) : t("login");
    acc.title = s.loggedIn ? t("logout_title") : "";
  }

  const title = $("title"), sub = $("subtitle"), btn = $("primary"), notice = $("notice");
  const row = $("serverRow"), sw = $("toggle");
  title.classList.toggle("on", s.enabled && !busy);
  title.classList.toggle("busy", busy);
  notice.hidden = true;
  notice.className = "notice";
  notice.replaceChildren();
  btn.className = "primary";
  btn.disabled = busy;

  const current = s.proxies.find((p) => p.id === (selectedId || s.selected)) || s.proxies[0];
  selectedId = current ? current.id : null;
  $("titleText").textContent = busy ? t("busy") : s.enabled ? t("on_title") : t("off_title");
  sub.textContent = s.enabled ? t("on_sub", { s: proxyName(current) }) : s.loggedIn ? t("off_sub") : t("guest_sub");

  row.hidden = !(s.loggedIn && s.proxies.length);
  if (current) {
    $("serverFlag").textContent = flag(current.country);
    $("serverName").textContent = proxyName(current);
  }
  $("serverBtn").disabled = busy || s.proxies.length < 2;
  $("serverList").replaceChildren(...s.proxies.map((p) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.tabIndex = 0;
    li.setAttribute("aria-selected", String(current && p.id === current.id));
    li.innerHTML = '<span class="flag"></span><span class="nm"></span><svg class="ok" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
    li.querySelector(".flag").textContent = flag(p.country);
    li.querySelector(".nm").textContent = proxyName(p);
    const pick = () => choose(p.id);
    li.onclick = pick;
    li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
    return li;
  }));

  const say = (text, warn) => { notice.append(text); notice.hidden = false; if (warn) notice.classList.add("warn"); };
  if (s.error === "subscription_required") say(t("expired"), true);
  else if (s.uiError) say(s.uiError, true);

  let action = null;
  if (!s.loggedIn) {
    btn.textContent = t("login_to_enable");
    action = () => show("login");
  } else if (s.enabled) {
    btn.textContent = t("disable");
    btn.classList.add("off");
    action = disconnect;
  } else if (!canUse(s.account)) {
    if (!s.error && !s.uiError) {
      say(t("need_sub") + " ");
      const a = document.createElement("a");
      a.href = "#"; a.textContent = "«" + t("refresh") + "»";
      a.onclick = (e) => { e.preventDefault(); refresh(); };
      notice.append(a);
    }
    btn.textContent = t("buy");
    action = () => open("/dashboard/");
  } else if (!s.proxies.length) {
    say(t("no_servers"));
    btn.textContent = t("refresh");
    action = refresh;
  } else if (s.control && !s.control.includes("this_extension")) {
    say(t("other_ext"), true);
    btn.textContent = t("enable");
    btn.disabled = true;
  } else {
    btn.textContent = t("enable");
    action = connect;
  }
  btn.onclick = action;

  sw.setAttribute("aria-checked", String(s.enabled));
  sw.querySelector(".switch-text").textContent = s.enabled ? t("sw_on") : t("sw_off");
  sw.disabled = busy || (!s.enabled && action !== connect);

  // Settings
  const st = s.settings || {};
  for (const b of $("lang").children) b.classList.toggle("active", b.dataset.v === (st.lang || "auto"));
  $("set-webrtc").checked = st.webrtc !== false;
  $("set-autostart").checked = st.autostart !== false;
}

async function load() {
  const r = await send("state");
  state = { ...(r.data || { loggedIn: false, proxies: [], enabled: false }), uiError: state && state.uiError };
  const lang = state.settings && state.settings.lang;
  const want = lang === "ru" ? true : lang === "en" ? false : !(navigator.language || "ru").toLowerCase().startsWith("en");
  if (want !== ru) { ru = want; texts(); }
  render();
}

async function run(type, data) {
  busy = true; state.uiError = null; render();
  const r = await send(type, data);
  busy = false;
  await load();
  if (!r.ok) { state.uiError = errText(r); render(); }
  return r;
}

const connect = () => run("connect", { id: selectedId });

function togglePicker(open) {
  const list = $("serverList"), btn = $("serverBtn");
  const show = open ?? list.hidden;
  list.hidden = !show;
  btn.setAttribute("aria-expanded", String(show));
  if (show) (list.querySelector('[aria-selected="true"]') || list.firstChild)?.focus();
}

function choose(id) {
  togglePicker(false);
  if (id === selectedId) return;
  selectedId = id;
  if (state.enabled) connect(); else render();
}
const disconnect = () => run("disconnect");
const refresh = () => run("refresh");

function open(path) {
  if (!inExtension) return void window.open(SITE + path);
  chrome.tabs.create({ url: SITE + path });
  window.close();
}

async function setSetting(patch) {
  await send("settings", { patch });
  await load();
}

async function doLogin(type, data, form) {
  const b = form.querySelector("button");
  b.disabled = true;
  const r = await send(type, data);
  b.disabled = false;
  if (!r.ok) {
    $("loginError").textContent = errText(r);
    $("loginError").hidden = false;
    return;
  }
  await send("refresh");
  show("home");
  await load();
}

function init() {
  texts();
  $("ver").textContent = "fsociety NET " + (inExtension ? "v" + chrome.runtime.getManifest().version : "preview");

  for (const a of document.querySelectorAll("[data-open]")) a.onclick = (e) => { e.preventDefault(); open(a.dataset.open); };
  for (const b of document.querySelectorAll(".nav[data-view]")) b.onclick = () => show(b.dataset.view);
  $("tg").classList.add("soon");
  $("tg").onclick = () => { $("navLabel").textContent = t("nav_tg"); };   // the app's Telegram — link later

  $("back").onclick = () => show("home");
  $("account").onclick = async () => {
    if (!state.loggedIn) return show("login");
    // Two clicks instead of confirm(): a dialog can close the popup in some browsers
    const acc = $("account");
    if (acc.dataset.armed) { delete acc.dataset.armed; await send("logout"); await load(); return; }
    acc.dataset.armed = "1";
    acc.textContent = t("logout_q");
    setTimeout(() => { delete acc.dataset.armed; if (state) render(); }, 3000);
  };
  for (const tab of document.querySelectorAll(".tab")) {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === tab));
      $("formPass").hidden = tab.dataset.tab !== "pass";
      $("formCode").hidden = tab.dataset.tab !== "code";
      $("loginError").hidden = true;
    };
  }
  $("formPass").onsubmit = (e) => {
    e.preventDefault();
    doLogin("login", { username: $("user").value.trim(), password: $("pass").value }, e.target);
  };
  $("formCode").onsubmit = (e) => {
    e.preventDefault();
    doLogin("loginCode", { code: $("code").value.replace(/\D/g, "") }, e.target);
  };
  $("code").oninput = (e) => {
    const d = e.target.value.replace(/\D/g, "").slice(0, 16);
    e.target.value = d.replace(/(\d{4})(?=\d)/g, "$1-");
  };
  $("serverBtn").onclick = (e) => { e.stopPropagation(); togglePicker(); };
  document.addEventListener("click", (e) => { if (!$("serverRow").contains(e.target)) togglePicker(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") togglePicker(false); });
  $("toggle").onclick = () => (state.enabled ? disconnect() : connect());

  for (const b of $("lang").children) b.onclick = () => setSetting({ lang: b.dataset.v });
  $("set-webrtc").onchange = (e) => setSetting({ webrtc: e.target.checked });
  $("set-autostart").onchange = (e) => setSetting({ autostart: e.target.checked });
  $("diagBtn").onclick = async () => {
    const out = $("diag");
    out.hidden = false; out.textContent = t("diag_run");
    const r = await send("diag");
    out.textContent = r.ok ? r.data.join("\n") : errText(r);
  };

  show("home");
  load().then(() => { if (state.loggedIn) send("refresh").then(load); });
}

init();
