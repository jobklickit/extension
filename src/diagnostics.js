(() => {
  const api = globalThis.browser ?? chrome;
  const output = document.getElementById('log-output');
  const status = document.getElementById('log-status');
  const panel = document.getElementById('diagnostics');
  const toggle = document.getElementById('diagnostics-toggle');
  async function send(type) {
    const response = await api.runtime.sendMessage({ type });
    if (!response?.ok) throw new Error(response?.error || 'Hintergrundskript nicht erreichbar. Erweiterung neu laden.');
    return response.result;
  }
  async function refresh() {
    try {
      const value = await send('jobklick:logs:get');
      output.value = JSON.stringify(value, null, 2);
      status.textContent = `${value.entries.length} Ereignisse · Version ${value.version}`;
    } catch (error) { status.textContent = error.message; }
  }
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) refresh();
  });
  document.getElementById('refresh-logs').addEventListener('click', refresh);
  document.getElementById('copy-logs').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      status.textContent = '✓ Diagnose kopiert.';
    } catch {
      output.focus();
      output.select();
      status.textContent = 'Protokoll markiert. Mit Strg+C / ⌘C kopieren.';
    }
  });
  document.getElementById('clear-logs').addEventListener('click', async () => {
    try { await send('jobklick:logs:clear'); await refresh(); }
    catch (error) { status.textContent = error.message; }
  });
})();
