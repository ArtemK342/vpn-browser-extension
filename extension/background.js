// fsociety NET — browser extension service worker.
// Login (same API as the apps), HTTPS proxy credentials from /api/vpn/browser-proxy (paid accounts only,
// live 12 h, renewed here), chrome.proxy fixed_servers + proxy auth via webRequest.onAuthRequired.

const API = ["https://fsociety-vpn.org/api/", "https://api.fsociety-vpn.org/api/"]; // Cloudflare, then direct
const RENEW_BEFORE = 2 * 3600;   // renew proxy credentials when < 2 h left
const ALARM = "renew";

const store = {
  get: (k) => chrome.storage.local.get(k),
  set: (o) => chrome.storage.local.set(o),
  del: (k) => chrome.storage.local.remove(k),
};

class ApiError extends Error {
  constructor(status, code, message) { super(message || code || String(status)); this.status = status; this.code = code; }
}

async function request(path, { method = "GET", body, form, token } = {}) {
  let lastErr;
  for (const base of API) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(form).toString(); }
    else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    let resp;
    try {
      resp = await fetch(base + path, { method, headers, body: payload, cache: "no-store", signal: AbortSignal.timeout(12000) });
    } catch (e) { lastErr = new ApiError(0, "network"); continue; }   // network → try the direct host
    // Cloudflare cut / gateway errors → the direct host
    if ([502, 503, 504, 520, 521, 522, 523, 524].includes(resp.status) && base === API[0]) {
      const t = await resp.text().catch(() => "");
      if (!t.trim().startsWith("{")) { lastErr = new ApiError(resp.status, "network"); continue; }
      return finish(resp.status, t);
    }
    return finish(resp.status, await resp.text().catch(() => ""));
  }
  throw lastErr || new ApiError(0, "network");
}

function finish(status, text) {
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (status >= 200 && status < 300) return j;
  const d = j && j.detail;
  if (d && typeof d === "object") throw new ApiError(status, d.code, d.message);
  throw new ApiError(status, status === 401 ? "unauthorized" : "server", typeof d === "string" ? d : "");
}

// ── Auth ──
async function authed(path, opts = {}) {
  const { auth } = await store.get("auth");
  if (!auth) throw new ApiError(401, "unauthorized");
  try {
    return await request(path, { ...opts, token: auth.access });
  } catch (e) {
    if (e.status !== 401) throw e;
    let t;
    try { t = await request("refresh", { method: "POST", body: { refresh_token: auth.refresh } }); }
    catch (e2) { if (e2.status === 401) await logout(); throw e2; }
    await store.set({ auth: { access: t.access_token, refresh: t.refresh_token } });
    return request(path, { ...opts, token: t.access_token });
  }
}

async function saveLogin(t) {
  await store.set({ auth: { access: t.access_token, refresh: t.refresh_token } });
  await loadAccount();
}

async function loadAccount() {
  const [me, sub] = await Promise.all([authed("me"), authed("subscription").catch(() => null)]);
  const kind = me.account_type === "numeric" ? "code" : me.account_type === "username" ? "login" : "email";
  const label = kind === "code" ? "" : (me.email || "");   // /me: email, or the login for username accounts
  const paid = !!(sub && sub.is_active && sub.plan && sub.plan !== "free");
  const account = { kind, label, plan: paid ? sub.plan : "free", expires_at: (sub && sub.expires_at) || null,
                    role: me.role || "user" };
  await store.set({ account });
  return account;
}

async function logout() {
  await disconnect();
  await store.del(["auth", "account", "creds", "error"]);
}

// ── Proxy ──
async function fetchCreds() {
  const c = await authed("vpn/browser-proxy");
  await store.set({ creds: c });
  return c;
}

async function freshCreds() {
  const { creds } = await store.get("creds");
  if (creds && creds.proxies && creds.proxies.length && creds.expires - Date.now() / 1000 > RENEW_BEFORE) return creds;
  return fetchCreds();
}

async function applyProxy(p) {
  await chrome.proxy.settings.set({
    scope: "regular",
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: "https", host: p.host, port: Number(p.port) },
        bypassList: ["<local>", "localhost", "127.0.0.1", "[::1]"],
      },
    },
  });
}

// ── Settings ──
const DEFAULTS = { lang: "auto", webrtc: true, autostart: true };
async function settings() {
  const { settings: st } = await store.get("settings");
  return { ...DEFAULTS, ...(st || {}) };
}

// WebRTC: while the VPN is on, only proxied UDP — calls can't reveal the real IP
async function applyWebrtc(on) {
  if (!chrome.privacy || !chrome.privacy.network) return;
  try {
    if (on) await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" });
    else await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
  } catch { /* controlled by a policy */ }
}

async function connect(id) {
  await store.set({ error: null });
  const creds = await freshCreds();
  if (!creds.proxies || !creds.proxies.length) throw new ApiError(200, "no_servers");
  const { selected } = await store.get("selected");
  const want = id || selected;
  const p = creds.proxies.find((x) => x.id === want) || creds.proxies[0];
  await applyProxy(p);
  await store.set({ enabled: true, selected: p.id });
  await applyWebrtc((await settings()).webrtc);
  chrome.alarms.create(ALARM, { periodInMinutes: 30 });
  await paint();
}

async function disconnect() {
  try { await chrome.proxy.settings.clear({ scope: "regular" }); } catch { /* not ours */ }
  await applyWebrtc(false);
  await store.set({ enabled: false });
  chrome.alarms.clear(ALARM);
  await paint();
}

async function control() {
  // Another extension (or a policy) controls the proxy → ours can't work
  const s = await chrome.proxy.settings.get({});
  return s.levelOfControl;   // controlled_by_this_extension / controllable_by_this_extension / ...
}

async function paint() {
  const { enabled } = await store.get("enabled");
  const st = enabled ? "on" : "off";
  await chrome.action.setIcon({ path: { 16: `icons/${st}-16.png`, 32: `icons/${st}-32.png`, 48: `icons/${st}-48.png` } });
  await chrome.action.setBadgeText({ text: "" });
}

// Credentials for our proxy only (challenger = the proxy we set)
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) { callback({}); return; }
    store.get(["creds", "enabled"]).then(({ creds, enabled }) => {
      const ours = enabled && creds && creds.proxies &&
        creds.proxies.some((p) => p.host === details.challenger.host && Number(p.port) === details.challenger.port);
      // Second ask for the same request = wrong / expired password: renew once, then give up (no loop)
      if (!ours) { callback({}); return; }
      if (seen.has(details.requestId)) {
        seen.delete(details.requestId);
        fetchCreds().catch(() => {});
        callback({ cancel: true });
        return;
      }
      seen.add(details.requestId);
      setTimeout(() => seen.delete(details.requestId), 60000);
      callback({ authCredentials: { username: creds.username, password: creds.password } });
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);
const seen = new Set();

chrome.proxy.onProxyError.addListener(async (e) => {
  await store.set({ lastProxyError: { at: Date.now(), error: e.error } });
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  const { enabled } = await store.get("enabled");
  if (!enabled) return;
  try {
    await freshCreds();
  } catch (e) {
    // Subscription ended / logged out → turn off, otherwise the browser would have no internet
    if (e.code === "subscription_required" || e.status === 401) {
      await disconnect();
      await store.set({ error: e.code || "unauthorized" });
    }
  }
});

// Restore after a browser restart: our proxy setting persists, the icon doesn't
chrome.runtime.onStartup.addListener(async () => {
  const { enabled } = await store.get("enabled");
  if (enabled && (await settings()).autostart) { try { await connect(); } catch { await disconnect(); } }
  else if (enabled) await disconnect();
  await paint();
});
chrome.runtime.onInstalled.addListener(paint);

// ── Messages from the popup ──
const handlers = {
  async state() {
    const s = await store.get(["auth", "account", "creds", "enabled", "selected", "error"]);
    return { loggedIn: !!s.auth, account: s.account || null, proxies: (s.creds && s.creds.proxies) || [],
             enabled: !!s.enabled, selected: s.selected || null, error: s.error || null, control: await control(),
             settings: await settings() };
  },
  async settings({ patch }) {
    const st = { ...(await settings()), ...(patch || {}) };
    for (const k of Object.keys(st)) if (!(k in DEFAULTS)) delete st[k];
    await store.set({ settings: st });
    const { enabled } = await store.get("enabled");
    if ("webrtc" in (patch || {}) && enabled) await applyWebrtc(st.webrtc);
  },
  // Diagnostics: no addresses or tokens in the output, only yes/no and timings
  async diag() {
    const out = [];
    const s = await store.get(["auth", "creds", "enabled", "lastProxyError"]);
    out.push(`version: ${chrome.runtime.getManifest().version}`);
    out.push(`account: ${s.auth ? "signed in" : "signed out"}`);
    out.push(`proxy control: ${await control()}`);
    out.push(`vpn: ${s.enabled ? "on" : "off"}`);
    const left = s.creds && s.creds.expires ? Math.round((s.creds.expires - Date.now() / 1000) / 60) : null;
    out.push(`servers: ${(s.creds && s.creds.proxies && s.creds.proxies.length) || 0}` + (left !== null ? `, key ${left} min` : ""));
    for (const base of API) {
      const t0 = Date.now();
      try {
        const r = await fetch(base + "news", { cache: "no-store", signal: AbortSignal.timeout(8000) });
        out.push(`api ${new URL(base).host}: ${r.status} ${Date.now() - t0} ms`);
      } catch { out.push(`api ${new URL(base).host}: unreachable`); }
    }
    if (s.enabled) {
      const t0 = Date.now();
      try {
        await fetch("https://www.google.com/generate_204", { cache: "no-store", signal: AbortSignal.timeout(10000) });
        out.push(`via vpn: ok ${Date.now() - t0} ms`);
      } catch { out.push("via vpn: fail"); }
    }
    if (s.lastProxyError) out.push(`last proxy error: ${s.lastProxyError.error} (${new Date(s.lastProxyError.at).toLocaleString()})`);
    return out;
  },
  async login({ username, password }) {
    await saveLogin(await request("login", { method: "POST", form: { username, password, grant_type: "password" } }));
  },
  async loginCode({ code }) {
    await saveLogin(await request("login-numeric", { method: "POST", body: { code } }));
  },
  async logout() { await logout(); },
  async refresh() {
    const account = await loadAccount();
    if (account.plan !== "free" || ["tester", "developer", "admin", "superadmin"].includes(account.role)) {
      await fetchCreds().catch(() => {});
    }
  },
  async connect({ id }) { await connect(id); },
  async disconnect() { await disconnect(); },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const h = handlers[msg && msg.type];
  if (!h) return false;
  h(msg).then((r) => reply({ ok: true, data: r }),
              (e) => reply({ ok: false, status: e.status || 0, code: e.code || "error", message: e.message || "" }));
  return true;
});
