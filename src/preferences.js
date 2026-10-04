// Popup: the "Ausschlussfilter" subpage. Words are chips; AI suggestions are added on demand (one AI call per click).
(() => {
  const api = globalThis.browser ?? chrome;
  const $ = id => document.getElementById(id);
  const form = $('filters-form');
  const chips = $('keyword-chips');
  const input = $('keyword-input');
  const out = $('filters-status');
  const suggestions = $('keyword-suggestions');
  const suggest = $('suggest-keywords');
  const acceptAll = $('accept-all');
  const save = $('save-filters');
  const modes = { mute: 'Ausgrauen', hide: 'Ausblenden', show: 'Nur markieren' };
  let words = [];
  let suggested = [];
  let generation = 0;

  const icon = path => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  const mode = () => form.querySelector('input[name="filter-mode"]:checked')?.value || 'mute';
  const count = n => `${n} ${n === 1 ? 'Begriff' : 'Begriffe'}`;

  function render() {
    chips.replaceChildren(...words.map(word => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = word;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `${word} entfernen`);
      remove.innerHTML = icon('M18 6 6 18M6 6l12 12');
      remove.addEventListener('click', () => { words = words.filter(w => w !== word); render(); });
      chip.append(remove);
      return chip;
    }));
    suggested = suggested.filter(word => !words.includes(word));
    suggestions.replaceChildren(...suggested.map(word => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip suggestion';
      chip.innerHTML = icon('M5 12h14M12 5v14');
      chip.append(word);
      chip.addEventListener('click', () => add(word));
      return chip;
    }));
    acceptAll.hidden = !suggested.length;
    $('filters-count').textContent = count(words.length);
    $('filters-summary').textContent = words.length ? `${count(words.length)} · ${modes[mode()]}` : 'Begriffe im Titel ausschließen';
  }
  function add(word) {
    word = word.trim();
    if (word && !words.some(w => w.toLowerCase() === word.toLowerCase())) words.push(word);
    render();
  }

  async function send(message) {
    const response = await api.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'Backend nicht erreichbar.');
    return response.result;
  }

  async function load() {
    const current = ++generation;
    save.disabled = suggest.disabled = true;
    suggested = [];
    try {
      const value = await send({ type: 'jobklick:preferences' });
      if (current !== generation) return;
      words = value.excluded_keywords;
      const radio = form.querySelector(`input[name="filter-mode"][value="${value.filter_mode}"]`);
      if (radio) radio.checked = true;
      out.textContent = '';
      save.disabled = suggest.disabled = false;
      render();
    } catch (error) {
      if (current === generation) out.textContent = `Bitte zuerst verbinden. ${error.message}`;
    }
  }

  // Enter adds a word instead of submitting; commas split pasted lists.
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    input.value.split(',').forEach(add);
    input.value = '';
  });
  form.addEventListener('change', event => { if (event.target.name === 'filter-mode') render(); });
  acceptAll.addEventListener('click', () => suggested.slice().forEach(add));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (input.value.trim()) { input.value.split(',').forEach(add); input.value = ''; }
    const current = generation;
    save.disabled = true;
    out.textContent = 'Filter werden gespeichert …';
    try {
      const value = await send({ type: 'jobklick:preferences', value: { excluded_keywords: words, filter_mode: mode() } });
      if (current !== generation) return;
      words = value.excluded_keywords;
      render();
      await api.storage.local.set({ listingRevision: Date.now() }); // open listing tabs re-apply the filter
      out.textContent = '✓ Gespeichert. Offene Stellenlisten werden aktualisiert.';
    } catch (error) { out.textContent = error.message; }
    finally { if (current === generation) save.disabled = false; }
  });

  suggest.addEventListener('click', async () => {
    const current = generation;
    suggest.disabled = true;
    out.textContent = 'KI sucht ähnliche Begriffe …';
    try {
      const result = await send({ type: 'jobklick:suggest-exclusions', keywords: words });
      if (current !== generation) return;
      suggested = result.suggestions;
      render();
      out.textContent = suggested.length ? '' : 'Keine weiteren Begriffe vorgeschlagen.';
    } catch (error) { if (current === generation) out.textContent = error.message; }
    finally { if (current === generation) suggest.disabled = false; }
  });

  // Subpage navigation.
  const show = filters => {
    $('view-main').hidden = filters;
    $('view-filters').hidden = !filters;
    (filters ? input : $('open-filters')).focus();
  };
  $('open-filters').addEventListener('click', () => show(true));
  $('close-filters').addEventListener('click', () => show(false));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('view-filters').hidden) { event.preventDefault(); show(false); } });

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('backend' in changes || 'token' in changes)) load();
  });
  load();
})();
