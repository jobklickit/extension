// "Stellen auf dieser Seite finden": injected on demand into any page (activeTab), finds the job listings on it and
// marks the interesting ones. It never saves anything: the background asks the backend which ones fit and passes
// the answers to jobklickMark. Plain functions, no page messaging: everything goes through executeScript results.

// Pages that load more listings on scroll (jooble): scroll to the end until nothing new arrives, then back.
// ponytail: scroll only; boards that need a "Mehr laden" click still show just what's loaded.
globalThis.jobklickLoadMore = async () => {
  const start = window.scrollY;
  const size = () => document.documentElement.scrollHeight + document.querySelectorAll('a[href]').length;
  let still = 0, rounds = 0;
  for (; rounds < 12 && still < 2; rounds++) {
    const before = size();
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    await new Promise(resolve => setTimeout(resolve, 900));
    still = size() === before ? still + 1 : 0;
  }
  window.scrollTo({ top: start, behavior: 'instant' });
  return rounds;
};

// Lists every job on the page as {id, url, title, text} and tags its card with data-jobklick-scan=id.
globalThis.jobklickScan = () => {
  const words = text => text.replace(/\s+/g, ' ').trim();
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const chrome = 'nav, aside, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true]';
  // The page's header and footer are chrome; a card's own <header> (title row) isn't.
  const pageEdge = a => { const edge = a.closest('header, footer'); return edge && !edge.parentElement?.closest('article, li, section'); };
  document.querySelectorAll('[data-jobklick-scan]').forEach(el => {
    el.removeAttribute('data-jobklick-scan');
    el.removeAttribute('data-jobklick-interest');
  });

  // Job links: a few words of visible text, outside the page's navigation, header and footer.
  const links = [...document.querySelectorAll('a[href]')].filter(a => {
    const text = words(a.innerText || '');
    const count = text.split(' ').length;
    return text.length >= 6 && text.length <= 160 && count >= 2 && count <= 20
      && /^https?:$/.test(new URL(a.href, location.href).protocol) && !a.closest(chrome) && !pageEdge(a) && visible(a);
  });

  // Listings repeat: links whose surroundings share tags and classes (numbers stripped) are one list.
  const signature = a => {
    const parts = [];
    for (let node = a, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      parts.push(node.tagName + '.' + [...node.classList].filter(c => !/\d/.test(c)).sort().join('.'));
    }
    return parts.join('>');
  };
  const groups = new Map();
  for (const a of links) (groups.get(signature(a)) ?? groups.set(signature(a), []).get(signature(a))).push(a);
  const lists = [...groups.values()].filter(group => group.length >= 3);
  const largest = Math.max(0, ...lists.map(group => group.length));
  // ponytail: the biggest repeated list (and any at least half its size, e.g. "Top-Jobs" above the results).
  // Pages that mix job cards with same-shaped other lists (e.g. related searches) can still slip in.
  const chosen = lists.filter(group => group.length * 2 >= largest);

  // The card: the largest ancestor that holds just this one link of its list.
  const cardOf = (a, group) => {
    let card = a;
    for (let depth = 0; depth < 8 && card.parentElement && card.parentElement !== document.body; depth++) {
      if (group.some(other => other !== a && card.parentElement.contains(other))) break;
      card = card.parentElement;
    }
    return card;
  };

  const jobs = [], seen = new Set();
  for (const group of chosen) {
    for (const a of group) {
      const url = new URL(a.href, location.href);
      url.hash = '';
      if (seen.has(url.href) || jobs.length >= 150) continue;
      seen.add(url.href);
      const card = cardOf(a, group);
      const id = String(jobs.length);
      card.dataset.jobklickScan = id;
      jobs.push({ id, url: url.href, title: words(a.innerText).slice(0, 500), text: words(card.innerText || '').slice(0, 2000) });
    }
  }
  return jobs;
};

// Marks the results: an outline on interesting cards (dashed: maybe), excluded ones dimmed, and one panel listing
// the hits with why. Nothing is inserted into the cards themselves (on many boards that squeezes their layout).
// meta.ai: 'pending' while the AI pass runs, true once it answered, or the reason it couldn't.
globalThis.jobklickMark = (results, meta = {}) => {
  if (!document.getElementById('jobklick-scan-style')) {
    const style = document.createElement('style');
    style.id = 'jobklick-scan-style';
    style.textContent = '[data-jobklick-interest=high]{outline:2px solid #c6f135!important;outline-offset:3px;border-radius:6px}'
      + '[data-jobklick-interest=maybe]{outline:2px dashed #9bbf1f!important;outline-offset:3px;border-radius:6px}'
      + '[data-jobklick-interest=excluded]{opacity:.45!important}';
    document.head.append(style);
  }
  document.querySelector('[data-jobklick-ui=scan]')?.remove();
  const hits = [];
  for (const result of results) {
    const card = document.querySelector(`[data-jobklick-scan="${result.id}"]`);
    if (!card) continue;
    card.dataset.jobklickInterest = result.interest;
    if (result.interest === 'high' || result.interest === 'maybe') hits.push({ card, ...result });
  }
  hits.sort((a, b) => (a.interest === 'high' ? 0 : 1) - (b.interest === 'high' ? 0 : 1));

  const host = document.createElement('div');
  host.dataset.jobklickUi = 'scan';
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{--paper:#fff;--ink:#111;--grey:#5c5c57;--line:#e4e4de;--chip:#f2f2ec;--marker:#c6f135;
      font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}
    @media (prefers-color-scheme:dark){:host{--paper:#1b1b1b;--ink:#f2f2f2;--grey:#a8a8a8;--line:#3a3a3a;--chip:#262626}}
    .panel{width:320px;max-height:60vh;display:flex;flex-direction:column;border:1px solid var(--line);border-radius:12px;
      background:var(--paper);box-shadow:0 8px 24px #0002;overflow:hidden}
    .head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);font-weight:700}
    .dot{width:8px;height:8px;border-radius:2px;background:var(--marker);box-shadow:0 0 0 1px #111}
    .head span{flex:1} button{font:inherit;cursor:pointer;border:0;background:none;color:var(--grey);padding:2px 6px;border-radius:6px}
    button:hover{background:var(--chip);color:var(--ink)} ul{list-style:none;margin:0;padding:4px;overflow:auto}
    li button{display:block;width:100%;text-align:left;color:var(--ink);padding:8px}
    .why{display:block;color:var(--grey);font-size:12px} .empty,.note{padding:10px 12px;color:var(--grey);margin:0}
    .note{padding:6px 12px;border-top:1px solid var(--line);font-size:12px}
    .tag{display:inline-block;margin-right:6px;padding:0 6px;border-radius:999px;background:var(--marker);color:#111;font-size:11px;font-weight:700}
    .tag.maybe{background:var(--chip);color:var(--ink)}
  </style><section class="panel" aria-label="jobklick.it Stellen auf dieser Seite">
    <div class="head"><i class="dot"></i><span></span><button type="button" class="close" aria-label="Schließen">✕</button></div>
    <ul></ul><p class="note"></p></section>`;
  const sure = hits.filter(hit => hit.interest === 'high').length;
  shadow.querySelector('.head span').textContent = `${sure} passen, ${hits.length - sure} vielleicht (von ${results.length})`;
  shadow.querySelector('.note').textContent = meta.ai === 'pending' ? 'KI schaut sich die Titel an …'
    : meta.ai === true ? 'Mit KI eingeschätzt. Gespeichert wird nichts.' : `Nur Wortabgleich${meta.ai ? ` (${meta.ai})` : ''}.`;
  const list = shadow.querySelector('ul');
  if (!hits.length) {
    list.outerHTML = '<p class="empty">Keine Treffer zu deinen Skills oder gespeicherten Stellen.</p>';
  }
  for (const hit of hits) {
    const examples = hit.feedback.examples.filter(example => example.vote === 1).map(example => example.title);
    const why = [hit.ai_reason ? `KI: ${hit.ai_reason}` : '', hit.matched_skills.length ? `Skills: ${hit.matched_skills.join(', ')}` : '',
      examples.length ? `Ähnlich wie: ${examples[0]}` : ''].filter(Boolean).join(' · ');
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const tag = document.createElement('span');
    tag.className = hit.interest === 'high' ? 'tag' : 'tag maybe';
    tag.textContent = hit.interest === 'high' ? 'passt' : 'vielleicht';
    button.append(tag, hit.title);  // page text: as text only, never HTML
    const reason = document.createElement('span');
    reason.className = 'why';
    reason.textContent = why;
    button.append(reason);
    button.addEventListener('click', () => hit.card.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    item.append(button);
    list?.append(item);
  }
  shadow.querySelector('.close').addEventListener('click', () => {
    host.remove();
    document.querySelectorAll('[data-jobklick-interest]').forEach(el => el.removeAttribute('data-jobklick-interest'));
  });
  document.body.append(host);
  return { found: results.length, interesting: sure, maybe: hits.length - sure };
};

// executeScript({files}) returns the file's last value; a function can't be cloned back (Firefox: "non-structured-clonable").
undefined;
