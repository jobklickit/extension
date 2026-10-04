// Deliberately accepts only diagnostic metadata. No URLs, messages, tokens or page/profile text.
(() => {
  if (globalThis.jobklickLog) return;
  const api = globalThis.browser ?? chrome;
  const KEY = 'diagnosticLog';
  const LIMIT = 200;
  const AGE = 7 * 24 * 60 * 60 * 1000;
  const EVENTS = new Set(['background.ready', 'background.installed', 'page.ready', 'page.already_active',
    'page.scan', 'page.unsupported', 'page.url_failed', 'injection.started', 'injection.completed', 'injection.failed', 'injection.empty',
    'permission.granted', 'permission.denied', 'request.started', 'request.completed', 'request.failed',
    'action.started', 'action.completed', 'action.failed', 'settings.saved', 'filters.saved', 'suggestions.completed']);
  const ENDPOINTS = new Set(['jobs', 'profile', 'listings/preview', 'listings/feedback', 'listings/preferences', 'listings/exclusion-suggestions']);
  const ACTIONS = new Set(['save-job', 'fill-form', 'save', 'vote', 'preview', 'preferences', 'suggest-exclusions']);
  const ERRORS = new Set(['permission', 'network', 'timeout', 'extension_unavailable', 'invalid_data', 'unknown']);
  let background = false;
  let queue = Promise.resolve();

  function sanitize(entry) {
    if (!entry || !EVENTS.has(entry.event)) return null;
    const data = {};
    for (const key of ['cards', 'controls', 'candidates', 'links', 'rejected_links', 'frames', 'added', 'removed', 'count', 'tabId', 'status', 'duration_ms']) {
      if (Number.isFinite(entry.data?.[key])) data[key] = Math.max(0, Math.round(entry.data[key]));
    }
    for (const [key, allowed] of [['endpoint', ENDPOINTS], ['action', ACTIONS], ['error', ERRORS],
      ['site', new Set(['stepstone', 'indeed', 'linkedin'])], ['method', new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])],
      ['error_name', new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'SecurityError', 'DataCloneError'])]]) {
      if (allowed.has(entry.data?.[key])) data[key] = entry.data[key];
    }
    if (typeof entry.data?.host === 'string' && /^[a-z0-9.:[\]-]{1,253}$/i.test(entry.data.host)) data.host = entry.data.host;
    if (typeof entry.data?.configured === 'boolean') data.configured = entry.data.configured;
    return { time: new Date().toISOString(), level: ['info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
      context: ['page', 'popup', 'background'].includes(entry.context) ? entry.context : 'page', event: entry.event, data };
  }

  function enqueue(task) {
    queue = queue.then(task).catch(() => {}); // diagnostics must never break extension actions
    return queue;
  }

  function store(entry) {
    const clean = sanitize(entry);
    if (!clean) return Promise.resolve();
    return enqueue(async () => {
      const value = await api.storage.local.get(KEY);
      const entries = Array.isArray(value[KEY]) ? value[KEY] : [];
      const recent = entries.filter(item => Date.parse(item.time) >= Date.now() - AGE);
      await api.storage.local.set({ [KEY]: [...recent, clean].slice(-LIMIT) });
    });
  }

  function write(level, event, data = {}) {
    const context = background ? 'background' : typeof location !== 'undefined' && location.protocol === 'https:' ? 'page' : 'popup';
    const entry = sanitize({ level, event, data, context });
    if (!entry) return;
    console[entry.level](`[jobklick] ${entry.event}`, entry.data);
    if (background) return store(entry);
    try { Promise.resolve(api.runtime.sendMessage({ type: 'jobklick:log', entry })).catch(() => {}); } catch {}
  }

  globalThis.jobklickLog = {
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    useStorage() { background = true; },
    store,
    receive(entry) {
      const clean = sanitize(entry);
      if (!clean) return Promise.resolve();
      console[clean.level](`[jobklick/${clean.context}] ${clean.event}`, clean.data);
      return store(clean);
    },
    async read() {
      await queue;
      const value = await api.storage.local.get(KEY);
      return (Array.isArray(value[KEY]) ? value[KEY] : []).filter(item => Date.parse(item.time) >= Date.now() - AGE).slice(-LIMIT);
    },
    clear: () => enqueue(() => api.storage.local.remove(KEY)),
    errorCode(error) {
      const message = String(error?.message || '');
      if (/permission|denied|Cannot access|Zugriff/i.test(message)) return 'permission';
      if (/timeout|abort/i.test(error?.name || '')) return 'timeout';
      if (/Extension context|Receiving end|Could not establish/i.test(message)) return 'extension_unavailable';
      if (/fetch|network/i.test(message)) return 'network';
      if (/Ungültig|invalid/i.test(message)) return 'invalid_data';
      return 'unknown';
    },
  };
})();
