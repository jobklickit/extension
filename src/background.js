if (typeof importScripts === 'function' && !globalThis.jobklickLog) importScripts('logging.js');
const api = globalThis.browser ?? chrome;
const log = globalThis.jobklickLog;
log?.useStorage();
log?.info('background.ready');

api.runtime.onInstalled.addListener(() => {
  log?.info('background.installed');
  api.contextMenus.create({ id: "save-job", title: "Job speichern", contexts: ["page", "selection", "link"] });
  api.contextMenus.create({ id: "fill-form", title: "Bewerbungsformular ausfüllen", contexts: ["page", "editable"] });
  api.contextMenus.create({ id: "scan-page", title: "Stellen auf dieser Seite finden", contexts: ["page"] });
});

// Runs inside the listing page; must be self-contained.
function capture() {
  const structured = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { structured.push(JSON.parse(s.textContent)); } catch {}
  }
  return {
    url: location.href,
    page_title: document.title,
    captured_at: new Date().toISOString(),
    text: document.body.innerText,
    structured_data: structured.length ? structured : null,
  };
}

function badge(tabId, text, color) {
  // Safari does not implement every badge API. Feedback must never fail a save.
  const update = (method, details) => {
    try { Promise.resolve(api.action[method]?.(details)).catch(console.warn); } catch (e) { console.warn(e); }
  };
  update("setBadgeBackgroundColor", { tabId, color });
  update("setBadgeText", { tabId, text });
  update("setTitle", { tabId, title: `jobklick.it: ${text}` });
  setTimeout(() => {
    update("setBadgeText", { tabId, text: "" });
    update("setTitle", { tabId, title: "jobklick.it" });
  }, 3000);
}

async function call(path, options = {}) {
  const { backend = "https://app.jobklick.it", token = "" } = await api.storage.local.get(["backend", "token"]);
  const started = Date.now();
  const details = { endpoint: path, method: options.method || 'GET', configured: Boolean(token) };
  log?.info('request.started', details);
  let res;
  try { res = await fetch(`${backend}/api/${path}`, {
    signal: AbortSignal.timeout(150000),
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Token ${token}` },
  }); } catch (error) {
    log?.error('request.failed', { ...details, duration_ms: Date.now() - started, error: log.errorCode(error) });
    throw error;
  }
  log?.[res.ok ? 'info' : 'error'](res.ok ? 'request.completed' : 'request.failed', {
    ...details, status: res.status, duration_ms: Date.now() - started,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("Bitte Token und Backend-Zugriff im Erweiterungs-Popup prüfen.");
    const error = await res.json().catch(() => ({}));
    throw new Error(typeof error.detail === "string" ? error.detail : `Backend antwortet mit ${res.status}.`);
  }
  return res.json();
}

async function saveJob(tab) {
  const [{ result }] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: capture });
  const job = await call("jobs", { method: "POST", body: JSON.stringify(result) });
  badge(tab.id, "✓", "#2e7d32");
  return { id: job.id };
}

// Runs inside the page; must be self-contained. The schema.org JobPosting's headline facts, for the popup card.
function detectPosting() {
  const found = [];
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const type = [].concat(value["@type"] || []);
    if (type.includes("JobPosting")) found.push(value);
    if (value["@graph"]) walk(value["@graph"]);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { walk(JSON.parse(s.textContent)); } catch {}
  }
  const posting = found[0];
  if (!posting) return null;
  const text = value => (typeof value === "string" ? value : value?.name || "").trim().slice(0, 200);
  const place = [].concat(posting.jobLocation || [])[0]?.address;
  return {
    title: text(posting.title),
    company: text(posting.hiringOrganization),
    location: text(place?.addressLocality || place) || (posting.jobLocationType === "TELECOMMUTE" ? "Remote" : ""),
  };
}

async function fillForm(tab, frameId) {
  // Profile comes from the backend on every use; nothing personal is stored in the extension.
  const profile = await call("profile");
  // ponytail: fills the frame that was right-clicked (or the page). Forms in cross-origin iframes
  // (e.g. embedded Greenhouse) need that frame right-clicked directly, or host permissions for it.
  const target = { tabId: tab.id, frameIds: [frameId ?? 0] };
  await api.scripting.executeScript({ target, files: ["fill.js"] });
  const run = async (func, args = []) => (await api.scripting.executeScript({ target, func, args }))[0].result;
  // One form entry per profile entry, so the AI pass has a slot for each job and degree.
  await run((c) => jobTrackerExpand(c), [{ experience: profile.experience.length, education: profile.education.length }]);
  let filled = await run((p) => jobTrackerFill(p), [profile]);
  // Second pass: the backend's AI answers what the rules could not (education, motivation, …). Rule-filled
  // fields stay if it fails (the error still shows as "!"); AI answers are outlined amber for review.
  // Nothing is ever submitted.
  const form = await run(() => jobTrackerCollect());
  if (form.fields.length) {
    badge(tab.id, "…", "#f0b429");
    const { answers } = await call("fill", { method: "POST", body: JSON.stringify(form) });
    filled += await run((a) => jobTrackerApply(a), [answers]);
  }
  badge(tab.id, String(filled), filled ? "#2e7d32" : "#9aa1b6");
  return { filled };
}

// Any page, on demand (activeTab): load all listings, find them, mark the fitting ones. Saves nothing.
// First the fast word matching (marked at once), then one AI request for all titles refines it when available.
async function scanPage(tab) {
  const target = { tabId: tab.id };
  const run = async (func, args = []) => (await api.scripting.executeScript({ target, func, args }))[0].result;
  badge(tab.id, "…", "#9aa1b6");
  await api.scripting.executeScript({ target, files: ["scan.js"] });
  await run(() => globalThis.jobklickLoadMore());
  const jobs = await run(() => globalThis.jobklickScan());
  const results = [];
  for (let i = 0; i < jobs.length; i += 20) { // the preview takes 20 listings per request
    const batch = jobs.slice(i, i + 20);
    const { listings } = await call("listings/preview", { method: "POST", body: JSON.stringify({
      listings: batch.map(job => ({ url: job.url, title: job.title, text: job.text })) }) });
    listings.forEach((value, index) => results.push({ id: batch[index].id, title: batch[index].title, ...value }));
  }
  if (!jobs.length) return run((r, m) => globalThis.jobklickMark(r, m), [results, { ai: false }]);
  await run((r, m) => globalThis.jobklickMark(r, m), [results, { ai: "pending" }]);
  let ai = "pending";
  try {
    const { listings } = await call("listings/rank", { method: "POST", body: JSON.stringify({
      listings: jobs.map(job => ({ id: job.id, title: job.title, text: job.text.slice(0, 300) })) }) });
    const judged = new Map(listings.map(item => [item.id, item]));
    for (const result of results) {
      const item = judged.get(result.id);
      if (!item || result.interest === "excluded") continue; // the user's exclusions always win
      result.ai_reason = item.reason;
      if (item.fit === "passt") result.interest = "high";
      else if (item.fit === "vielleicht" && result.interest !== "high") result.interest = "maybe";
    }
    ai = true;
  } catch (error) { ai = error.message; } // no AI (or it failed): the word matching stands
  const marked = await run((r, m) => globalThis.jobklickMark(r, m), [results, { ai }]);
  log?.info('scan.completed', { tabId: tab.id, found: marked.found, interesting: marked.interesting, maybe: marked.maybe, ai: ai === true });
  badge(tab.id, String(marked.interesting), marked.interesting ? "#2e7d32" : "#9aa1b6");
  return marked;
}

api.contextMenus.onClicked.addListener(async (info, tab) => {
  log?.info('action.started', { action: info.menuItemId, tabId: tab.id });
  try {
    if (info.menuItemId === "fill-form") await fillForm(tab, info.frameId);
    else if (info.menuItemId === "scan-page") await scanPage(tab);
    else await saveJob(tab);
    log?.info('action.completed', { action: info.menuItemId, tabId: tab.id });
  } catch (e) {
    log?.error('action.failed', { action: info.menuItemId, tabId: tab.id, error: log.errorCode(e) });
    badge(tab.id, "!", "#c62828");
  }
});

// Only the extension's own content scripts can use listing actions. Never expose tokens or
// full profile data to job-board pages, and never accept an arbitrary API path from a page.
function supportedPage(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && /(^|\.)(stepstone\.(de|at|be)|indeed\.(com|de|co\.uk|fr|at|ch)|linkedin\.com)$/.test(hostname);
  } catch { return false; }
}

function listingPayload(value, textLimit = 20000) {
  if (!value || typeof value.url !== "string" || !supportedPage(value.url)) throw new Error("Ungültiger Stellenlink.");
  return {
    url: value.url.slice(0, 2000),
    title: String(value.title || "").slice(0, 500),
    text: String(value.text || "").slice(0, textLimit),
  };
}

async function listingMessage(message, sender) {
  const fromPopup = !sender.tab && sender.url === api.runtime.getURL("options.html");
  if (!fromPopup && !(sender.tab && supportedPage(sender.url))) throw new Error("Nicht unterstützte Seite.");
  const json = (body, method = "POST") => ({ method, body: JSON.stringify(body) });
  switch (message.type) {
    case 'jobklick:logs:get': {
      if (!fromPopup) throw new Error('Diagnose im Erweiterungs-Popup öffnen.');
      const stored = await api.storage.local.get(['backend', 'token']);
      let backendHost = '';
      try { backendHost = new URL(stored.backend || 'https://app.jobklick.it').hostname; } catch {}
      const permissions = await api.permissions.getAll();
      return { version: api.runtime.getManifest().version, backendHost, tokenConfigured: Boolean(stored.token),
        grantedOrigins: permissions.origins || [], entries: await log.read() };
    }
    case 'jobklick:logs:clear':
      if (!fromPopup) throw new Error('Diagnose im Erweiterungs-Popup öffnen.');
      await log.clear();
      return {};
    case "jobklick:scan": { // the popup's "Stellen auf dieser Seite finden"; popup-open granted activeTab
      if (!fromPopup) throw new Error("Nur aus dem Erweiterungs-Popup.");
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("Auf dieser Seite nicht möglich.");
      return scanPage(tab);
    }
    case "jobklick:page:detect": // the popup's "Stelle erkannt" card; null where pages can't be read (chrome://, stores)
    case "jobklick:page:save":
    case "jobklick:page:fill": {
      if (!fromPopup) throw new Error("Nur aus dem Erweiterungs-Popup.");
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("Auf dieser Seite nicht möglich.");
      if (message.type === "jobklick:page:save") return saveJob(tab);
      if (message.type === "jobklick:page:fill") return fillForm(tab);
      try { return (await api.scripting.executeScript({ target: { tabId: tab.id }, func: detectPosting }))[0].result; }
      catch { return null; }
    }
    case "jobklick:preview": {
      if (!Array.isArray(message.listings) || !message.listings.length || message.listings.length > 20) throw new Error("Ungültige Vorschau.");
      return call("listings/preview", json({ listings: message.listings.map(value => listingPayload(value)) }));
    }
    case "jobklick:save": {
      const listing = listingPayload(message.listing, 100000);
      const result = await call("jobs", json({ ...listing, mode: "capture", page_title: listing.title,
        captured_at: new Date().toISOString(), structured_data: {
          "@graph": Array.isArray(message.postings) ? message.postings : [],
          jobklick_capture: { scope: ["detail", "fetched"].includes(message.scope) ? message.scope : "card", source_page: sender.url },
        } }));
      if (sender.tab) badge(sender.tab.id, "✓", "#2e7d32");
      return { id: result.id };
    }
    case "jobklick:vote":
      if (![-1, 0, 1].includes(message.vote)) throw new Error("Ungültige Bewertung.");
      return call("listings/feedback", json({ ...listingPayload(message.listing), vote: message.vote }));
    case "jobklick:preferences":
      if (!fromPopup) throw new Error("Filter im Erweiterungs-Popup bearbeiten.");
      return call("listings/preferences", message.value ? json(message.value, "PUT") : {});
    case "jobklick:suggest-exclusions":
      if (!fromPopup) throw new Error("Filter im Erweiterungs-Popup bearbeiten.");
      return call("listings/exclusion-suggestions", json({ excluded_keywords: message.keywords }));
    default:
      throw new Error("Unbekannte Aktion.");
  }
}

// Connecting (options.js opened the tab): once the user confirmed, the page carries the new key. Top level, so it
// wakes the service worker. The page is found by its content, the URL is the same before and after the POST.
api.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const { connectTabId } = await api.storage.local.get("connectTabId");
  if (tabId !== connectTabId) return;
  try {
    const [{ result: token } = {}] = await api.scripting.executeScript({
      target: { tabId },
      func: () => document.querySelector("[data-extension-token]")?.dataset.extensionToken ?? null,
    });
    if (!token) return; // still the login or confirm step
    await api.storage.local.set({ token });
    await api.storage.local.remove("connectTabId");
    log?.info('settings.connected');
    badge(tabId, "✓", "#287549");
  } catch (error) {
    log?.warn('connect.failed', { error: log.errorCode(error) }); // e.g. host permission revoked meanwhile
  }
});

api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id || !message?.type?.startsWith("jobklick:")) return;
  if (message.type === 'jobklick:log') {
    if (sender.tab && !supportedPage(sender.url)) return;
    log?.receive(message.entry).then(() => respond({ ok: true }));
    return true;
  }
  const action = message.type.slice('jobklick:'.length);
  const quiet = action.startsWith('logs:') || action === 'page:detect'; // runs on every popup open: would crowd the log
  if (!quiet) log?.info('action.started', { action, tabId: sender.tab?.id });
  listingMessage(message, sender).then(
    result => {
      if (!quiet) log?.info('action.completed', { action, tabId: sender.tab?.id });
      respond({ ok: true, result });
    },
    error => {
      if (!quiet) log?.error('action.failed', { action, tabId: sender.tab?.id, error: log.errorCode(error) });
      respond({ ok: false, error: error.message || "Backend nicht erreichbar." });
    },
  );
  return true; // Callback response keeps the channel open on Chrome, Firefox and Safari.
});
