// A direct repair path for withheld site permissions and already-open tabs, especially Firefox MV3.
(() => {
  const api = globalThis.browser ?? chrome;
  const button = document.getElementById('activate-listings');
  const status = document.getElementById('page-status');
  let tab;
  async function execute(options) {
    const results = await api.scripting.executeScript({ target: { tabId: tab.id }, ...options });
    const failure = results?.find(result => result.error);
    if (failure) throw new Error(failure.error.message || String(failure.error));
    if (!results?.length) throw new Error('Firefox hat kein Ergebnis der Seitenausführung geliefert.');
    return results[0].result;
  }
  api.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    const current = tabs[0];
    if (!current?.url) return;
    const url = new URL(current.url);
    if (url.protocol !== 'https:' || !/(^|\.)(stepstone\.(de|at|be)|indeed\.(com|de|co\.uk|fr|at|ch)|linkedin\.com)$/.test(url.hostname)) return;
    tab = current;
    button.disabled = false;
    document.getElementById('page-actions')?.removeAttribute?.('hidden');
  }).catch(() => {});

  button.addEventListener('click', async () => {
    if (!tab) return;
    button.disabled = true;
    try {
      // This must be the first async operation, while the click's user gesture is active.
      const allowed = await api.permissions.request({ origins: [`${new URL(tab.url).origin}/*`] });
      globalThis.jobklickLog?.info(allowed ? 'permission.granted' : 'permission.denied', { host: new URL(tab.url).hostname });
      if (!allowed) throw new Error('Bitte den Zugriff auf diese Jobbörse erlauben.');
      globalThis.jobklickLog?.info('injection.started', { tabId: tab.id, host: new URL(tab.url).hostname });
      await execute({ files: ['logging.js', 'listings.js'] });
      const health = await execute({ func: () => ({ active: Boolean(globalThis.jobklickListings),
        ...globalThis.jobklickListingStatus,
        controls: document.querySelectorAll('[data-jobklick-ui="listing"]').length,
      }) });
      if (!health?.active) throw new Error('Das Seitenskript wurde nicht initialisiert. Bitte die StepStone-Seite neu laden.');
      globalThis.jobklickLog?.[health.controls ? 'info' : 'warn'](health.controls ? 'injection.completed' : 'injection.empty', { ...health, tabId: tab.id });
      status.textContent = health.controls
        ? `✓ ${health.controls} Stellen-Buttons aktiviert. Popup schließen, um sie zu sehen.`
        : `Seitenskript aktiv, aber keine Stellen erkannt (${health.candidates || 0} Karten, ${health.links || 0} Links). Details unter Diagnose (Symbol oben rechts).`;
    } catch (error) {
      globalThis.jobklickLog?.error('injection.failed', { tabId: tab.id, error: globalThis.jobklickLog.errorCode(error) });
      status.textContent = `${error.message} Falls nötig, Erweiterung und Seite neu laden.`;
    } finally { button.disabled = false; }
  });
})();
