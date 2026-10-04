// Page adapters read the board the user is browsing (plus visible cards' full ads). Matching lives in Django.
(() => {
  const log = globalThis.jobklickLog;
  if (globalThis.jobklickListings) {
    log?.info('page.already_active');
    globalThis.jobklickRescan?.();
    return;
  }
  const api = globalThis.browser ?? chrome;
  const adapters = {
    stepstone: {
      cards: '[data-testid="job-item"], [data-testid="job-card"], [data-at="job-item"], article[id^="job-item-"]',
      link: 'a[data-at="job-item-title"], a[data-testid="job-item-title"], a[href*="/stellenangebote--"], a[href*="/job/"]',
      details: '[data-at="job-ad-content"], [data-testid="job-ad-content"], [data-at="job-ad-wrapper"]',
    },
    indeed: {
      cards: '.job_seen_beacon, .resultContent, [data-testid="slider_item"]',
      link: 'a.jcs-JobTitle, h2.jobTitle a, a[data-jk]',
      details: '#jobsearch-ViewjobPaneWrapper, .jobsearch-JobComponent',
      ad: '#jobDescriptionText',
    },
    linkedin: {
      cards: '.jobs-search-results__list-item, .job-card-container, .base-card',
      link: 'a.job-card-list__title--link, a.job-card-container__link, a.base-card__full-link, a[href*="/jobs/view/"]',
      details: '.jobs-search__job-details--container, .jobs-details, .job-view-layout, .details-pane__content',
      place: 'after', // LinkedIn cards lay out side by side: inside, the bar took a column and squeezed the title
    },
  };
  const site = Object.keys(adapters).find(key => location.hostname.split('.').includes(key));
  if (!site) { log?.warn('page.unsupported'); return; }
  log?.info('page.ready', { site, host: location.hostname });
  const adapter = adapters[site];
  const records = new Map();
  let previewRunning = false;
  let revision = 0;
  let scanTimer, previewTimer;
  let showHidden = false;
  let settings = { filter_mode: 'mute' };
  let lastScanCount = -1;
  let rejectedLinks = 0;
  const style = document.createElement('style');
  style.textContent = '[data-jobklick-muted]{opacity:.45!important} [data-jobklick-hidden]{display:none!important}';
  document.head.append(style);

  const toolbarHost = document.createElement('div');
  toolbarHost.dataset.jobklickUi = 'toolbar';
  toolbarHost.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647';
  const toolbar = toolbarHost.attachShadow({ mode: 'open' });
  toolbar.innerHTML = '<style>button{font:700 13px "Bricolage Grotesque",system-ui,sans-serif;background:#c5f82a;color:#000;border:2px solid #000;border-radius:8px;padding:9px 14px;box-shadow:0 4px 16px #0003;cursor:pointer}button:hover{background:#000;color:#c5f82a}</style><button type="button"></button>';
  document.body.append(toolbarHost);
  toolbarHost.hidden = true;
  toolbar.querySelector('button').onclick = () => {
    showHidden = !showHidden;
    for (const record of records.values()) applyFilter(record);
    updateToolbar();
  };

  async function send(message) {
    const response = await api.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'Erweiterung neu laden und Backend-Verbindung prüfen.');
    return response.result;
  }

  function jobURL(raw, jobKey) {
    try {
      const url = new URL(raw, location.href);
      const sameSite = site === 'linkedin' ? /(^|\.)linkedin\.com$/.test(url.hostname)
        : url.hostname.replace(/^www\./, '') === location.hostname.replace(/^www\./, '');
      if (url.protocol !== 'https:' || !sameSite) return null;
      if (site === 'indeed') {
        const key = jobKey || url.searchParams.get('jk') || url.searchParams.get('vjk');
        if (!key || !/^[a-zA-Z0-9_-]+$/.test(key)) return null;
        return `${url.origin}/viewjob?jk=${encodeURIComponent(key)}`;
      }
      if (site === 'linkedin') {
        const id = url.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/)?.[1] || url.searchParams.get('currentJobId');
        return id && /^\d+$/.test(id) ? `https://www.linkedin.com/jobs/view/${id}` : null;
      }
      if (!/\/stellenangebote--|\/job\//i.test(url.pathname)) return null;
      url.hash = '';
      // Firefox's content-script Xray wrapper can hide Symbol.iterator on keys().
      // Collect through forEach, then delete: mutating during iteration skips parameters.
      const keys = [];
      url.searchParams.forEach((_value, key) => keys.push(key));
      for (const key of keys) {
        if (/^(utm_|tracking|ref|cid|suid|source|rltr$)/i.test(key)) url.searchParams.delete(key);
      }
      return url.href;
    } catch (error) {
      if (!rejectedLinks++) log?.error('page.url_failed', { site, error: log.errorCode(error), error_name: error.name });
      return null;
    }
  }

  function textOf(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, [hidden], [aria-hidden="true"], [data-jobklick-ui]').forEach(node => node.remove());
    const walker = root.ownerDocument.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const parts = [];
    while (walker.nextNode()) parts.push(walker.currentNode.textContent);
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 100000);
  }

  function cardData(root) {
    const links = root.matches(adapter.link) ? [root] : root.querySelectorAll(adapter.link);
    for (const link of links) {
      const url = jobURL(link.getAttribute('href'), link.getAttribute('data-jk') || root.getAttribute('data-jk'));
      if (!url) continue;
      const title = textOf(link).slice(0, 500);
      const ad = fullAds.get(url);
      return ad ? { url, title, text: `${title} ${ad.text}`.slice(0, 100000), scope: 'card', full: true }
        : { url, title, text: textOf(root), scope: 'card' };
    }
    return null;
  }

  function detailData(root) {
    const heading = root.querySelector('h1, h2.jobsearch-JobInfoHeader-title, .job-details-jobs-unified-top-card__job-title')
      || (site === 'stepstone' && document.querySelector('[data-at="header-job-title"]'));
    const link = heading?.querySelector('a[href]');
    const url = jobURL(link?.href || location.href);
    if (!url || !heading) return null;
    return { url, title: textOf(heading).slice(0, 500), text: `${textOf(heading)} ${textOf(root)}`.slice(0, 100000), scope: 'detail' };
  }

  // A fetched ad page may omit the posting's url; the current page may list other jobs' postings.
  function postingsIn(doc, url, lenient = false) {
    const postings = [];
    function walk(node) {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if ([node['@type']].flat().includes('JobPosting')) {
        // A search page's other JobPostings must never be attached to this card.
        if (typeof node.url === 'string' ? jobURL(node.url) === url : lenient) postings.push(node);
      } else if (node['@graph']) walk(node['@graph']);
    }
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { walk(JSON.parse(script.textContent)); } catch {}
    }
    return postings;
  }

  function postingsFor(data) {
    return data.full ? fullAds.get(data.url)?.postings ?? [] : postingsIn(document, data.url);
  }

  // Card snippets rarely list skills, so read each visible card's full ad the way the user would:
  // a same-origin fetch in their own session, parsed without rendering. Card text stays the fallback.
  // ponytail: one request at a time with a fixed pause, stops for this page on 403/429.
  const fullAds = new Map(); // url -> { text, postings } | null when the ad could not be read
  const fetchQueue = [];
  let fetching = false;
  let fetchedAds = 0;
  let fetchBlocked = site === 'linkedin'; // LinkedIn renders ads from its API, not the HTML
  const visible = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const url = entry.isIntersecting && records.get(entry.target)?.data;
      if (url?.scope === 'card' && !fullAds.has(url.url) && !fetchQueue.includes(url.url)) fetchQueue.push(url.url);
    }
    fetchNext();
  });

  function adFrom(doc, url) {
    const postings = postingsIn(doc, url, true);
    const description = postings.map(posting => typeof posting.description === 'string'
      ? textOf(new DOMParser().parseFromString(posting.description, 'text/html').body) : '').join(' ').trim();
    const root = doc.querySelector(adapter.ad || adapter.details);
    const text = description || (root ? textOf(root) : '');
    return text ? { text, postings } : null;
  }

  async function fetchNext() {
    if (fetching || fetchBlocked || !fetchQueue.length) return;
    fetching = true;
    const url = fetchQueue.shift();
    try {
      const response = await fetch(url, { credentials: 'include' });
      if ([403, 429].includes(response.status)) {
        fetchBlocked = true;
        log?.warn('page.fetch_blocked', { site, status: response.status });
        return;
      }
      if (!response.ok || jobURL(response.url) !== url) throw new Error(`HTTP ${response.status}`);
      const ad = adFrom(new DOMParser().parseFromString(await response.text(), 'text/html'), url);
      fullAds.set(url, ad);
      // Re-match in batches of five so a results page costs a few preview requests, not one per ad.
      if (ad && (++fetchedAds % 5 === 0 || !fetchQueue.length)) scan();
    } catch (error) {
      fullAds.set(url, null);
      log?.warn('page.fetch_failed', { site, error: log.errorCode(error) });
    } finally {
      fetching = false;
      setTimeout(fetchNext, 1500);
    }
  }

  function updateToolbar() {
    const count = [...records.values()].filter(record => record.excluded && record.data.scope === 'card').length;
    toolbarHost.hidden = !count || settings.filter_mode !== 'hide';
    toolbar.querySelector('button').textContent = showHidden
      ? `jobklick.it · ${count} ausgeschlossene Stellen wieder ausblenden`
      : `jobklick.it · ${count} ausgeblendet – anzeigen`;
  }

  function applyFilter(record) {
    // Keep the open detail pane available even if its card is filtered.
    const card = record.data.scope === 'card';
    record.root.toggleAttribute('data-jobklick-muted', Boolean(record.excluded && settings.filter_mode === 'mute'));
    record.root.toggleAttribute('data-jobklick-hidden', Boolean(card && record.excluded && settings.filter_mode === 'hide' && !showHidden));
    record.host.style.display = record.root.hasAttribute('data-jobklick-hidden') ? 'none' : 'block';
  }

  function renderPreview(record, value) {
    record.vote = value.vote;
    record.excluded = value.excluded_keywords.length > 0;
    record.up.setAttribute('aria-pressed', String(record.vote === 1));
    record.down.setAttribute('aria-pressed', String(record.vote === -1));
    if (value.saved) {
      record.save.textContent = record.data.scope === 'detail' ? 'Anzeige erneut erfassen' : '✓ Gespeichert';
      record.save.disabled = record.data.scope !== 'detail';
    }
    const matched = value.matched_skills;
    // A card without its full ad (LinkedIn never lets us load it) only has title, company and place:
    // no match there says nothing about the job, so point to the open ad instead of "Keine Skills erwähnt".
    const cardOnly = record.data.scope === 'card' && !record.data.full;
    record.summary.textContent = !value.skill_count ? 'Skills im Profil ergänzen'
      : matched.length ? `${matched.length} ${matched.length === 1 ? 'Skill' : 'Skills'}: ${matched.join(', ')}`
      : cardOnly ? 'Skill-Abgleich: Anzeige öffnen' : 'Keine Skills erwähnt';
    record.summary.title = `${record.data.full ? 'Vollständige Anzeige' : record.data.scope === 'card' ? 'Nur Kartentext' : 'Sichtbare Anzeige'} abgeglichen`;
    const feedback = value.feedback;
    record.signal.textContent = feedback.positive || feedback.negative ? `Ähnliche: ${feedback.positive} 👍 · ${feedback.negative} 👎` : '';
    record.reason.textContent = value.excluded_keywords.length ? `Ausgeschlossen: ${value.excluded_keywords.join(', ')}` : '';
    record.details.textContent = feedback.examples.map(example =>
      `${example.vote === 1 ? '👍' : '👎'} ${example.title} (${example.shared_terms.join(', ')})`).join('\n');
    applyFilter(record);
  }

  function invalidate(reset = false) {
    revision++;
    for (const record of records.values()) {
      record.previewed = '';
      record.pending = false;
      if (reset) {
        record.vote = 0;
        record.excluded = false;
        record.save.disabled = false;
        record.save.textContent = 'Job speichern';
        record.up.setAttribute('aria-pressed', 'false');
        record.down.setAttribute('aria-pressed', 'false');
        record.summary.textContent = '…';
        record.signal.textContent = record.reason.textContent = record.details.textContent = record.error.textContent = '';
        applyFilter(record);
      }
    }
    schedulePreview();
  }

  function createRecord(root, data) {
    const host = document.createElement('div');
    host.dataset.jobklickUi = 'listing';
    const after = adapter.place === 'after' && data.scope === 'card';
    host.style.cssText = `display:block;position:relative;z-index:2;margin:${after ? '0 12px 8px' : '8px 0'}`;
    const shadow = host.attachShadow({ mode: 'open' });
    // Looks like jobklick.it: black ink, 2px edges, lime marker only on actions and selection.
    // Quiet on purpose: a thin outline, small pills and grey text, so the job board's own card stays in front.
    // Colours as in jobklick.it (lime only on the save action); the page's fonts aren't ours to load.
    shadow.innerHTML = `<style>
      :host{--paper:#fff;--ink:#111;--grey:#5c5c57;--line:#e4e4de;--chip:#f2f2ec;--marker:#c6f135;--danger:#b93838;
        font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);text-align:left;letter-spacing:0}
      @media (prefers-color-scheme:dark){:host{--paper:#1b1b1b;--ink:#f2f2f2;--grey:#a8a8a8;--line:#3a3a3a;--chip:#262626;--danger:#ff7b72}}
      .box{padding:3px 4px 3px 8px;border:1px solid var(--line);border-radius:8px;background:var(--paper)}
      .actions{display:flex;gap:4px;align-items:center}
      .brand{flex:none;width:8px;height:8px;margin-right:2px;border-radius:2px;background:var(--marker);box-shadow:0 0 0 1px #111}
      .match{flex:1;min-width:0;color:var(--grey);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      button{flex:none;font:inherit;font-weight:600;cursor:pointer;padding:2px 10px;border:1px solid var(--line);border-radius:999px;background:var(--paper);color:var(--ink)}
      button:hover{border-color:var(--ink)}
      button.save{background:var(--marker);border-color:var(--marker);color:#111} button.save:hover{border-color:#111}
      button.up,button.down{padding:2px 5px;border-color:transparent;background:none;filter:grayscale(1);opacity:.65}
      button.up:hover,button.down:hover{opacity:1;filter:none;background:var(--chip)}
      button[aria-pressed=true]{opacity:1;filter:none;background:var(--chip);border-color:var(--line)}
      button:disabled{cursor:default;opacity:.6} button.save:disabled{background:none;border-color:var(--line);color:var(--grey);opacity:1}
      button:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
      p{margin:3px 0 0} p:empty{display:none} .reason{color:var(--danger);font-weight:600} .error{color:var(--danger)}
      details{margin-top:3px;color:var(--grey)} details:has(.signal:empty){display:none} summary{cursor:pointer;width:max-content}
      details:has(.details:empty) summary{cursor:default;list-style:none} .details{white-space:pre-line}
    </style><section class="box" aria-label="jobklick Stellenbewertung">
      <div class="actions"><span class="brand" title="jobklick.it" aria-label="jobklick.it" role="img"></span><span class="match" aria-live="polite">…</span>
      <button class="save" type="button">Job speichern</button>
      <button class="up" type="button" aria-label="Interessant" aria-pressed="false" title="Mehr ähnliche Stellen">👍</button>
      <button class="down" type="button" aria-label="Uninteressant" aria-pressed="false" title="Weniger ähnliche Stellen">👎</button></div>
      <p class="reason"></p><details><summary class="signal"></summary><p class="details"></p></details><p class="error" role="status"></p>
    </section>`;
    // Avoid nesting interactive controls inside an anchor. Stop job-board click handlers.
    const anchor = root.closest('a');
    if (anchor) anchor.after(host); else if (after) root.after(host); else root.append(host);
    for (const event of ['click', 'mousedown', 'pointerdown', 'keydown', 'keyup']) host.addEventListener(event, e => e.stopPropagation());
    const record = { root, host, data, vote: 0, previewed: '', pending: false, excluded: false };
    for (const [key, selector] of Object.entries({ save: '.save', up: '.up', down: '.down', summary: '.match', signal: '.signal',
      reason: '.reason', details: '.details', error: '.error' })) record[key] = shadow.querySelector(selector);
    record.save.onclick = async event => {
      event.preventDefault();
      const captured = record.data;
      const startedRevision = revision;
      record.save.disabled = true;
      record.save.textContent = 'Speichert …';
      record.error.textContent = '';
      try {
        await send({ type: 'jobklick:save', listing: captured, scope: captured.full ? 'fetched' : captured.scope, postings: postingsFor(captured) });
        if (record.data.url === captured.url && revision === startedRevision) record.save.textContent = '✓ Gespeichert';
      } catch (error) {
        if (record.data.url === captured.url && revision === startedRevision) {
          record.save.disabled = false;
          record.save.textContent = 'Erneut speichern';
          record.error.textContent = error.message;
        }
      }
    };
    for (const [button, vote] of [[record.up, 1], [record.down, -1]]) button.onclick = async event => {
      event.preventDefault();
      const captured = record.data;
      const startedRevision = revision;
      record.up.disabled = record.down.disabled = true;
      record.error.textContent = '';
      try {
        const result = await send({ type: 'jobklick:vote', listing: captured, vote: record.vote === vote ? 0 : vote });
        if (record.data.url === captured.url && revision === startedRevision) {
          record.vote = result.vote;
          record.up.setAttribute('aria-pressed', String(result.vote === 1));
          record.down.setAttribute('aria-pressed', String(result.vote === -1));
        }
        invalidate();
        // Notify other open listing tabs without storing any listing or profile data locally.
        await api.storage.local.set({ listingRevision: Date.now() });
      } catch (error) { record.error.textContent = error.message; }
      finally { record.up.disabled = record.down.disabled = false; }
    };
    return record;
  }

  function schedulePreview() {
    if (!previewTimer) previewTimer = setTimeout(() => { previewTimer = null; preview(); }, 300);
  }

  async function preview() {
    if (previewRunning) return;
    const batch = [...records.values()].filter(record => record.previewed !== record.signature && !record.pending).slice(0, 20);
    if (!batch.length) return;
    previewRunning = true;
    const currentRevision = revision;
    const signatures = batch.map(record => record.signature);
    batch.forEach(record => { record.pending = true; });
    try {
      const result = await send({ type: 'jobklick:preview', listings: batch.map(record => record.data) });
      if (currentRevision !== revision) return;
      settings = result.preferences;
      batch.forEach((record, i) => {
        if (record.signature !== signatures[i] || !record.root.isConnected) return;
        renderPreview(record, result.listings[i]);
        record.previewed = signatures[i];
      });
      updateToolbar();
    } catch (error) {
      batch.forEach((record, i) => {
        if (record.signature !== signatures[i] || currentRevision !== revision) return;
        record.summary.textContent = 'Abgleich nicht verfügbar';
        record.error.textContent = error.message;
        record.previewed = signatures[i]; // no endless retries on an unavailable backend
      });
    } finally {
      batch.forEach(record => { record.pending = false; });
      previewRunning = false;
      if ([...records.values()].some(record => record.previewed !== record.signature)) schedulePreview();
    }
  }

  function scan() {
    const started = Date.now();
    let added = 0, removed = 0;
    rejectedLinks = 0;
    const found = new Map();
    const candidates = document.querySelectorAll(adapter.cards);
    const jobLinks = document.querySelectorAll(adapter.link);
    for (const [selector, read] of [[adapter.cards, cardData], [adapter.details, detailData]]) {
      for (const root of document.querySelectorAll(selector)) {
        // Prefer the outer card when a board has several matching wrappers for one job.
        if (root.parentElement?.closest(selector)) continue;
        const data = read(root);
        if (data) found.set(root, data);
      }
    }
    // Fall back from known job-title links when the board changes its card wrapper.
    for (const link of jobLinks) {
      if ([...found.keys()].some(root => root.contains(link))) continue;
      const root = link.closest('article, li, [data-genesis-element="CARD"]');
      if (!root) continue;
      const data = cardData(root);
      if (data) found.set(root, data);
    }
    for (const [root, record] of records) {
      if (!root.isConnected || !found.has(root) || !record.host.isConnected) {
        root.removeAttribute('data-jobklick-muted');
        root.removeAttribute('data-jobklick-hidden');
        record.host.remove();
        visible.unobserve(root);
        records.delete(root);
        removed++;
      }
    }
    for (const [root, data] of found) {
      let record = records.get(root);
      if (!record) { record = createRecord(root, data); records.set(root, record); visible.observe(root); added++; }
      const signature = JSON.stringify(data);
      if (record.signature !== signature) {
        record.data = data;
        record.signature = signature;
        record.vote = 0;
        record.excluded = false;
        record.save.disabled = false;
        record.save.textContent = 'Job speichern';
        record.up.setAttribute('aria-pressed', 'false');
        record.down.setAttribute('aria-pressed', 'false');
        record.summary.textContent = '…';
        record.signal.textContent = record.reason.textContent = record.details.textContent = record.error.textContent = '';
        applyFilter(record);
      }
    }
    updateToolbar();
    const counts = `${candidates.length}:${jobLinks.length}:${records.size}:${rejectedLinks}`;
    globalThis.jobklickListingStatus = { site, candidates: candidates.length, links: jobLinks.length,
      cards: found.size, controls: records.size, rejected_links: rejectedLinks, frames: document.querySelectorAll('iframe').length };
    if (counts !== lastScanCount || added || removed) {
      log?.info('page.scan', { ...globalThis.jobklickListingStatus, added, removed, duration_ms: Date.now() - started });
      lastScanCount = counts;
    }
    schedulePreview();
  }

  new MutationObserver(() => {
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 200);
  }).observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['href', 'data-jk', 'data-job-id'] });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ['listingRevision', 'backend', 'token'].some(key => key in changes)) {
      invalidate('backend' in changes || 'token' in changes);
    }
  });
  window.addEventListener('popstate', scan);
  scan();
  globalThis.jobklickListings = true;
  globalThis.jobklickRescan = scan;
})();
