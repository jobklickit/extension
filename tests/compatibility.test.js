const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

execFileSync("python3", [path.join(__dirname, "..", "build.py")]);
for (const name of ["chrome", "firefox", "safari"]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "dist", name, "manifest.json")));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal(name === "firefox" ? manifest.background.scripts.at(-1) : manifest.background.service_worker, "background.js");
  if (name === 'firefox') assert.equal(manifest.background.scripts[0], 'logging.js');
  assert.equal(Boolean(manifest.browser_specific_settings), name === "firefox");
  assert(manifest.host_permissions.includes('https://*.stepstone.de/*'));
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions);
  for (const asset of [...manifest.content_scripts[0].js, 'preferences.js', 'activation.js', 'diagnostics.js', 'scan.js', 'scanning.js', 'popup.css']) {
    assert(fs.existsSync(path.join(__dirname, '..', 'dist', name, asset)), `${name} must package ${asset}`);
  }
}

// The popup styles itself: nothing from the backend, so it looks right even when the backend is unreachable.
assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", "src", "options.html"), "utf8"), /static\/core|app\.css/);

async function test(namespace, grant) {
  let submit;
  let stored;
  let request;
  let fetches = 0;
  const elements = Object.fromEntries(["out", "settings-link", "token-link"].map(id => [id, {}]).concat([["connect", { addEventListener() {} }], ["conn-edit-toggle", { addEventListener() {}, setAttribute() {} }], ["conn-row", {}], ["conn-edit", {}], ["conn-status", { classList: { add() {}, remove() {} }, removeAttribute() {} }]]));
  const form = {
    backend: { value: "https://example.com:8443", addEventListener() {} },
    token: { value: " token " },
    addEventListener(event, listener) { submit = listener; },
    querySelector() { return { setAttribute() {}, removeAttribute() {} }; },
  };
  const api = {
    storage: { local: {
      get: async () => ({ backend: form.backend.value, token: form.token.value }),
      set: async value => { stored = value; },
    } },
    permissions: { request(details) { request = details; return Promise.resolve(grant); } },
  };
  const context = vm.createContext({
    [namespace]: api, URL,
    document: { getElementById: id => id === "f" ? form : elements[id] },
    fetch: async () => { fetches++; return { ok: true, json: async () => ({ full_name: "Test" }) }; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "options.js"), "utf8"), context);
  await Promise.resolve();
  assert.equal(elements["settings-link"].href, "https://example.com:8443/settings", "links follow the backend");
  const pending = submit({ preventDefault() {} });
  assert.equal(request.origins[0], "https://example.com/*", "permission requested during user gesture");
  await pending;
  assert.equal(fetches, grant ? 2 : 1, "stored token is checked on open, again after saving");
  assert.equal(stored?.backend, grant ? "https://example.com:8443" : undefined);
  assert.match(grant ? elements["conn-status"].textContent : elements.out.textContent, grant ? /Verbunden/ : /nicht erlaubt/);
  assert.equal(elements["conn-edit"].hidden, true, "connected: setup hidden behind ✎");
}

(async () => {
  for (const namespace of ["browser", "chrome"]) {
    await test(namespace, true);
    await test(namespace, false);
  }
  // Missing Safari badge color support must not prevent feedback.
  let text;
  const api = {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    contextMenus: { onClicked: { addListener() {} } },
    tabs: { onUpdated: { addListener() {} } },
    action: { setBadgeText(details) { text = details.text; }, setTitle() {} },
  };
  const context = vm.createContext({ browser: api, console, setTimeout() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8"), context);
  vm.runInContext('badge(1, "✓", "#2e7d32")', context);
  assert.equal(text, "✓");
  // Files injected with executeScript({files}) hand their last value back; Firefox rejects functions
  // ("result is non-structured-clonable data"), so scan.js must end on a plain value.
  const injected = vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "scan.js"), "utf8"), vm.createContext({ globalThis: {} }));
  assert.notEqual(typeof injected, "function", "scan.js must not end on a function");
  console.log("Cross-browser packaging, permissions and feedback checks passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
