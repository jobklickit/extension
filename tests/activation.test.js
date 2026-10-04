const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function check(allowed, {controls=25, failure=null} = {}) {
  let click;
  let requested = false;
  const injected = [];
  const button = {disabled:true, addEventListener(event, fn) {click = fn;}};
  const status = {};
  const api = {
    tabs: {query: async () => [{id:7, url:'https://www.stepstone.de/jobs/vollzeit/data-science/in-72108-rottenburg-am-neckar?ct=222'}]},
    permissions: {request: options => {
      assert.equal(options.origins[0], 'https://www.stepstone.de/*');
      requested = true;
      return Promise.resolve(allowed);
    }},
    scripting: {executeScript: async value => {
      injected.push(value);
      if (failure) return [{frameId:0, error:{message:failure}}];
      return [{frameId:0, result: value.files ? undefined : {active:true, candidates:25, links:25, controls}}];
    }},
  };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/../src/activation.js`, 'utf8'), {
    browser:api, URL, document:{getElementById: id => id === 'activate-listings' ? button : status},
  });
  await Promise.resolve();
  assert.equal(button.disabled, false);
  const pending = click();
  assert.equal(requested, true, 'request host permission before losing the user gesture');
  await pending;
  assert.equal(injected.length, allowed ? (failure ? 1 : 2) : 0);
  if (allowed) {
    assert.equal(injected[0].target.tabId, 7);
    assert.equal(injected[0].files[0], 'logging.js');
    assert.equal(injected[0].files[1], 'listings.js');
    if (failure) assert(status.textContent.includes(failure));
    else if (controls) assert.match(status.textContent, /25 Stellen-Buttons aktiviert/);
    else assert.match(status.textContent, /keine Stellen erkannt/);
  } else assert.match(status.textContent, /Zugriff/);
}
Promise.all([check(true), check(false), check(true, {controls:0}), check(true, {failure:'Script threw TypeError'})])
  .then(() => console.log('Firefox activation, injection errors, zero-card and permission-denial checks passed.'))
  .catch(error => {console.error(error); process.exitCode=1;});
