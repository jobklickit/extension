const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let listener;
let calls = [];
const api = {
  runtime: { id: 'test-extension', getURL: path => `moz-extension://test/${path}`,
    onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
  storage: { local: {
    get: async () => ({ backend: 'https://backend.example', token: 'test-token', connectTabId: 7 }),
    set: async value => { connected = value; }, remove: async () => {},
  } },
  action: { setBadgeText() {}, setTitle() {}, setBadgeBackgroundColor() {} },
  contextMenus: { onClicked: { addListener() {} } },
  tabs: { onUpdated: { addListener(fn) { onTabUpdated = fn; } } },
  scripting: { executeScript: async ({ target }) => [{ result: target.tabId === 7 && pageToken }] },
};
let onTabUpdated, connected, pageToken = null;
const context = vm.createContext({ browser: api, URL, AbortSignal, console, setTimeout() {},
  fetch: async (url, options) => { calls.push({url, options}); return {ok:true, json: async () => ({id:42, vote:1})}; },
});
vm.runInContext(fs.readFileSync(`${__dirname}/../src/background.js`, 'utf8'), context);
const sender = {id: 'test-extension', tab: {id:1}, url:'https://www.stepstone.de/jobs/data-science'};
const listing = {url:'https://www.stepstone.de/stellenangebote--Data--123-inline.html', title:'Data Scientist', text:'Python'};
const send = (message, from = sender) => new Promise(resolve => listener(message, from, resolve));

(async () => {
  let result = await send({type:'jobklick:save', listing, scope:'card', postings:[]});
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://backend.example/api/jobs');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.text, 'Python');
  assert.equal(body.structured_data.jobklick_capture.source_page, sender.url);
  assert.equal(body.structured_data.jobklick_capture.scope, 'card');
  assert.equal(result.result.id, 42);
  assert.equal('token' in result.result, false);
  await send({type:'jobklick:save', listing:{...listing, text:'a'.repeat(30000)}, scope:'detail'});
  assert.equal(JSON.parse(calls[1].options.body).text.length, 30000, 'snapshot retains text beyond the match-preview limit');
  await send({type:'jobklick:preview', listings:[{...listing, text:'a'.repeat(30000)}]});
  assert.equal(JSON.parse(calls[2].options.body).listings[0].text.length, 20000);
  calls = [];
  result = await send({type:'jobklick:preferences', value:{} });
  assert.equal(result.ok, false);
  result = await send({type:'jobklick:save', listing:{...listing, url:'https://evil.example/'} });
  assert.equal(result.ok, false);
  result = await send({type:'jobklick:vote', listing, vote:4});
  assert.equal(result.ok, false);
  result = await send({type:'jobklick:preview', listings:[listing]}, {...sender, url:'https://evil.example/'});
  assert.equal(result.ok, false);
  for (const type of ['jobklick:page:save', 'jobklick:page:fill']) { // the popup's buttons act on the active tab: popup only
    result = await send({type});
    assert.equal(result.ok, false, `${type} is popup-only`);
  }
  assert.equal(calls.length, 0);
  result = await send({type:'jobklick:vote', listing, vote:1});
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(calls[0].options.body).vote, 1);
  result = await send({type:'jobklick:preferences'}, {id:'test-extension', url:'moz-extension://test/options.html'});
  assert.equal(result.ok, true);
  // The popup card reads the JobPosting, also when it is nested in an @graph.
  context.document = { querySelectorAll: () => [{ textContent: JSON.stringify({ '@graph': [{ '@type': 'WebPage' },
    { '@type': 'JobPosting', title: 'Data Scientist', hiringOrganization: { name: 'Example GmbH' },
      jobLocation: [{ address: { addressLocality: 'Berlin' } }] }] }) }, { textContent: '{broken' }] };
  assert.deepEqual({ ...vm.runInContext('detectPosting()', context) }, { title: 'Data Scientist', company: 'Example GmbH', location: 'Berlin' });
  context.document = { querySelectorAll: () => [] };
  assert.equal(vm.runInContext('detectPosting()', context), null);
  // Connecting: only the tab options.js opened, and only once the confirmed page carries a key.
  await onTabUpdated(7, { status: 'complete' });
  assert.equal(connected, undefined, 'confirm step: no key on the page yet');
  pageToken = 'new-key';
  await onTabUpdated(8, { status: 'complete' });
  assert.equal(connected, undefined, 'another tab is ignored');
  await onTabUpdated(7, { status: 'complete' });
  assert.deepEqual({ ...connected }, { token: 'new-key' });
  console.log('Background messaging, capture isolation and vote routing checks passed.');
})().catch(error => {console.error(error); process.exitCode=1;});
