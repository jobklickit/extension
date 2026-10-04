const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/../src/logging.js`, 'utf8');
const state = {};
const printed = [];
const sent = [];
const api = {
  storage: {local: {
    get: async () => ({...state}),
    set: async value => {Object.assign(state, value);},
    remove: async key => {delete state[key];},
  }},
  runtime: {sendMessage: async message => {sent.push(message); return {ok:true};}},
};
const context = vm.createContext({browser:api, console:Object.fromEntries(['info','warn','error'].map(level => [level, (...args) => printed.push(args)]))});
vm.runInContext(source, context);
const log = context.jobklickLog;

(async () => {
  log.info('page.ready', {site:'stepstone', host:'www.stepstone.de', token:'SECRET', text:'PRIVATE', url:'https://example.com/private'});
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].entry.data.site, 'stepstone');
  assert(!JSON.stringify(sent).includes('SECRET'));
  assert(!JSON.stringify(printed).includes('PRIVATE'));
  log.useStorage();
  await Promise.all(Array.from({length:250}, (_, i) => log.info('request.completed', {
    endpoint:'jobs', status:200, count:i, headers:{Authorization:'SECRET'}, response:'PRIVATE',
  })));
  let entries = await log.read();
  assert.equal(entries.length, 200, 'bounded log survives concurrent writes');
  assert.equal(entries[0].data.count, 50);
  assert.equal(entries.at(-1).data.count, 249);
  assert(!JSON.stringify(entries).includes('SECRET'));
  assert(!JSON.stringify(entries).includes('PRIVATE'));
  await log.store({event:'request.failed', data:{endpoint:'https://secret', host:'https://secret/token', error:'token=SECRET', message:'PRIVATE'}});
  entries = await log.read();
  assert.deepEqual(Object.keys(entries.at(-1).data), []);
  await log.store({event:'SECRET', data:{}});
  assert(!(await log.read()).some(entry => entry.event === 'SECRET'));
  state.diagnosticLog.unshift({time:'2000-01-01T00:00:00Z', event:'old'});
  assert(!(await log.read()).some(entry => entry.event === 'old'));
  assert.equal(log.errorCode(new Error('Missing host permission: SECRET')), 'permission');
  await log.clear();
  assert.equal((await log.read()).length, 0);
  console.log('Diagnostic redaction, retention, concurrency and clearing checks passed.');
})().catch(error => {console.error(error); process.exitCode=1;});
