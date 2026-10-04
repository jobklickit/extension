const api = globalThis.browser ?? chrome;
const f = document.getElementById("f");
const out = document.getElementById("out");

const backend = () => {
  const url = new URL(f.backend.value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Bitte eine HTTP- oder HTTPS-Backend-URL ohne Zugangsdaten eingeben.");
  }
  return url.href.replace(/\/$/, "");
};

function call(path) {
  return fetch(`${backend()}/api/${path}`, { headers: { Authorization: `Token ${f.token.value.trim()}` } });
}

// Links into the app follow whatever backend URL is entered. The popup's styles are its own (popup.css).
function pointAtBackend() {
  document.getElementById("settings-link").href = `${backend()}/settings`;
  const app = document.getElementById("app-link");
  if (app) app.href = backend();
  const host = document.getElementById("app-host");
  if (host) host.textContent = new URL(backend()).host;
  document.getElementById("token-link").href = `${backend()}/settings#extension`;
}

api.storage.local.get(["backend", "token"]).then(({ backend = "https://app.jobklick.it", token = "" }) => {
  f.backend.value = backend;
  f.token.value = token;
  pointAtBackend();
  if (token) checkConnection();
  else { setStatus("Nicht verbunden", "bad"); showEdit(true); }
});

const connRow = document.getElementById("conn-row");
const connEdit = document.getElementById("conn-edit");
const editToggle = document.getElementById("conn-edit-toggle");
function showEdit(open) {
  connEdit.hidden = !open;
  editToggle.setAttribute("aria-expanded", String(open));
}
editToggle.addEventListener("click", () => showEdit(connEdit.hidden));

function setStatus(text, state) {
  const status = document.getElementById("conn-status");
  connRow.hidden = false;
  status.classList.remove("ok", "bad");
  if (state) status.classList.add(state);
  status.removeAttribute("title");
  status.textContent = text;
  return status;
}

// Connected: status under the logo, setup behind ✎. Anything else: setup open with the reason.
async function checkConnection() {
  setStatus("Prüfe …");
  let message;
  try {
    const res = await call("profile");
    globalThis.jobklickLog?.[res.ok ? 'info' : 'error'](res.ok ? 'request.completed' : 'request.failed', { endpoint: 'profile', status: res.status });
    if (res.ok) {
      const { full_name } = await res.json();
      const status = setStatus("Verbunden", "ok");
      if (full_name) status.title = `Verbunden als ${full_name}`;
      showEdit(false);
      return true;
    }
    message = res.status === 401 ? "✗ Token abgelehnt. Bitte neu verbinden." : `✗ Backend antwortet mit ${res.status}.`;
  } catch (err) {
    globalThis.jobklickLog?.error('request.failed', { endpoint: 'profile', error: globalThis.jobklickLog?.errorCode(err) });
    message = `✗ Backend nicht erreichbar (${err.message}). Läuft der Server?`;
  }
  setStatus("Nicht verbunden", "bad");
  out.textContent = message;
  showEdit(true);
  return false;
}
f.backend.addEventListener("change", () => {
  try { pointAtBackend(); } catch (err) { out.textContent = err.message; }
});

// One click: the app's /extension/connect page issues a token after the user confirms; background.js reads it.
document.getElementById("connect").addEventListener("click", async () => {
  try {
    const url = backend();
    // Request before any await: Firefox/Safari require the click's user gesture.
    if (!await api.permissions.request({ origins: [`${new URL(url).protocol}//${new URL(url).hostname}/*`] })) {
      out.textContent = "✗ Zugriff auf das Backend nicht erlaubt. Bitte erneut verbinden und den Zugriff erlauben.";
      return;
    }
    await api.storage.local.set({ backend: url });
    const tab = await api.tabs.create({ url: `${url}/extension/connect` });
    await api.storage.local.set({ connectTabId: tab.id });
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
  }
});

f.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = f.querySelector("button");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await saveAndTest();
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
});

async function saveAndTest() {
  const url = backend();
  // Request before any await: Firefox/Safari require the submit's user gesture.
  const origin = `${new URL(url).protocol}//${new URL(url).hostname}/*`;
  if (!await api.permissions.request({ origins: [origin] })) {
    globalThis.jobklickLog?.warn('permission.denied', { host: new URL(url).hostname });
    out.textContent = "✗ Zugriff auf das Backend nicht erlaubt. Bitte erneut speichern und den Zugriff erlauben.";
    return;
  }
  await api.storage.local.set({ backend: url, token: f.token.value.trim() });
  globalThis.jobklickLog?.info('settings.saved', { host: new URL(url).hostname, configured: Boolean(f.token.value.trim()) });
  pointAtBackend();
  out.textContent = "";
  await checkConnection();
}
