// Popup: what can be done with the open page. The card saves it or fills its form (same code as the context
// menu); "Stellen auf dieser Seite finden" marks fitting listings on the page and saves nothing.
(() => {
  const api = globalThis.browser ?? chrome;
  const $ = id => document.getElementById(id);
  const section = $('scan-actions');
  const button = $('scan-page');
  const status = $('scan-status');

  async function send(type) {
    const response = await api.runtime.sendMessage({ type });
    if (!response?.ok) throw new Error(response?.error || 'Keine Antwort.');
    return response.result;
  }

  api.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
    if (!/^https?:/.test(tab?.url || '')) return;
    section.hidden = false;
    const card = $('page-card');
    if (!card) return;
    $('page-label').textContent = 'Diese Seite';
    $('page-title').textContent = tab.title || new URL(tab.url).hostname;
    $('page-meta').textContent = new URL(tab.url).hostname;
    card.hidden = false;
    const posting = await send('jobklick:page:detect').catch(() => null);
    if (!posting?.title) return;
    $('page-label').textContent = '✓ Stelle erkannt';
    $('page-title').textContent = posting.title;
    $('page-meta').textContent = [posting.company, posting.location].filter(Boolean).join(' · ') || new URL(tab.url).hostname;
  }).catch(() => {});

  // Both page actions: busy while running, the result below the buttons.
  for (const [id, type, busy, done] of [
    ['page-save', 'jobklick:page:save', 'Wird gespeichert …', () => '✓ Gespeichert. Die Auswertung läuft im Hintergrund.'],
    ['page-fill', 'jobklick:page:fill', 'Füllt aus …', r => r.filled ? `✓ ${r.filled} Felder ausgefüllt. Bitte prüfen, nichts wird abgeschickt.` : 'Keine passenden Felder gefunden.'],
  ]) {
    const action = $(id);
    action?.addEventListener('click', async () => {
      const result = $('page-out');
      action.disabled = true;
      action.setAttribute('aria-busy', 'true');
      result.textContent = busy;
      try { result.textContent = done(await send(type)); }
      catch (error) { result.textContent = `✗ ${error.message}`; }
      finally { action.disabled = false; action.removeAttribute('aria-busy'); }
    });
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Lädt alle Stellen der Seite und schätzt sie ein …';
    try {
      const { found, interesting, maybe } = await send('jobklick:scan');
      status.textContent = found
        ? `${interesting} passen, ${maybe || 0} vielleicht (von ${found}). Popup schließen, um sie zu sehen.`
        : 'Keine Stellenliste auf dieser Seite erkannt.';
    } catch (error) {
      status.textContent = error.message;
    } finally { button.disabled = false; }
  });
})();
