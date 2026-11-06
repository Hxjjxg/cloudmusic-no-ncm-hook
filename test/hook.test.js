const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHook } = require('../plugin/hook.js');

function params(extension = 'flac') {
  return ['track-123-image', `C:\\TempD\\artist - title.${extension}`, 'cover.jpg', 'music:{}', {
    encrypt: true, media_rel_path: 'album/artist - title.ncm',
    image_rel_path: 'cover.jpg', tit2: 'title', trck: '1',
  }];
}

function fixture(options = {}, implementation) {
  const calls = [];
  const channel = { call: function (...args) {
    calls.push({ receiver: this, args });
    return implementation ? implementation.apply(this, args) : 42;
  } };
  const original = channel.call;
  const hook = createHook({ getChannel: () => channel, ...options });
  assert.equal(hook.install(), true);
  return { channel, original, hook, calls };
}

for (const extension of ['mp3', 'flac', 'FLAC']) {
  test(`preserves ${extension} downloads, tags, receiver, callback and return value`, () => {
    const { channel, hook, calls } = fixture();
    const input = params(extension);
    const before = structuredClone(input);
    const callback = () => {};
    const receiver = { marker: true };
    assert.equal(channel.call.call(receiver, 'storage.addid3', callback, input, 'extra'), 42);
    const { args } = calls[0];
    assert.equal(calls[0].receiver, receiver);
    assert.equal(args[1], callback);
    assert.equal(args[3], 'extra');
    assert.equal(args[2][4].encrypt, false);
    assert.equal(args[2][4].media_rel_path, `album/artist - title.${extension.toLowerCase()}`);
    assert.equal(args[2][4].tit2, 'title');
    assert.equal(args[2][3], 'music:{}');
    assert.deepEqual(input, before);
    assert.notEqual(args[2], input);
    assert.notEqual(args[2][4], input[4]);
    assert.equal(hook.status().patched, 1);
  });
}

test('does not rewrite unsupported, already processed or decrypting requests', () => {
  const { channel, hook, calls } = fixture();
  const cases = [null, {}, [], params('ncm'), params('wav')];
  const wrongId = params(); wrongId[0] = 'voice-123-image'; cases.push(wrongId);
  const unencrypted = params(); unencrypted[4].encrypt = false; cases.push(unencrypted);
  const numericFlag = params(); numericFlag[4].encrypt = 1; cases.push(numericFlag);
  const decrypting = params(); decrypting[4].decrypt = true; cases.push(decrypting);
  const changedOutput = params(); changedOutput[4].media_rel_path = 'other.flac'; cases.push(changedOutput);
  const missingOutput = params(); delete missingOutput[4].media_rel_path; cases.push(missingOutput);
  for (const input of cases) {
    channel.call('storage.addid3', null, input);
    assert.equal(calls.at(-1).args[2], input);
  }
  const ordinary = params(); channel.call('storage.other', null, ordinary);
  assert.equal(calls.at(-1).args[2], ordinary);
  assert.equal(hook.status().patched, 0);
});

test('enable/disable applies immediately while URL recording remains independent', () => {
  const { channel, hook, calls } = fixture();
  hook.setEnabled(false);
  const input = params();
  channel.call('storage.addid3', null, input);
  assert.equal(calls[0].args[2], input);
  const download = [{ id: 'track-123', mediaType: 1, url: 'http://cdn/audio.flac', size: 123 }];
  channel.call('download.start', null, download);
  assert.equal(hook.getRecords()[0].url, download[0].url);
  hook.setCaptureUrls(false);
  channel.call('download.start', null, download);
  assert.equal(hook.getRecords().length, 1);
  hook.setEnabled(true);
  channel.call('storage.addid3', null, input);
  assert.equal(calls.at(-1).args[2][4].encrypt, false);
});

test('records only audio, limits memory and returns detached snapshots', () => {
  const { channel, hook } = fixture({ maxRecords: 2 });
  channel.call('download.start', null, [{ id: 'track-123-image', mediaType: 0, url: 'cover.jpg' }]);
  assert.equal(hook.getRecords().length, 0);
  for (let i = 0; i < 3; i++) channel.call('download.start', null, [{
    id: 'track-123', mediaType: 1, url: `http://cdn/${i}.flac`,
  }]);
  const records = hook.getRecords();
  assert.deepEqual(records.map(x => x.url), ['http://cdn/1.flac', 'http://cdn/2.flac']);
  records[0].url = 'changed';
  assert.equal(hook.getRecords()[0].url, 'http://cdn/1.flac');
  assert.equal(hook.status().dropped, 1);
  hook.clearRecords();
  assert.equal(hook.status().records, 0);
  assert.equal(hook.status().dropped, 0);
});

test('native exceptions propagate once; logger exceptions cannot break native calls', () => {
  const failure = new Error('native failed');
  const { channel, calls } = fixture({ onEvent() { throw Error('logger failed'); } }, () => { throw failure; });
  assert.throws(() => channel.call('storage.addid3', null, params()), error => error === failure);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[2][4].encrypt, false);
});

test('installation is idempotent, supports a late bridge and restores the original', () => {
  let channel;
  const hook = createHook({ getChannel: () => channel });
  assert.equal(hook.install(), false);
  const original = () => 'native';
  channel = { call: original };
  assert.equal(hook.install(), true);
  const wrapped = channel.call;
  assert.equal(hook.install(), true);
  assert.equal(channel.call, wrapped);
  assert.equal(hook.dispose(), true);
  assert.equal(channel.call, original);
  assert.equal(hook.install(), false);
});

test('uninstall preserves a later plugin wrapper and leaves our inner hook inert', () => {
  const { channel, hook, calls } = fixture();
  const inner = channel.call;
  const outer = function (...args) { return inner.apply(this, args); };
  channel.call = outer;
  assert.equal(hook.dispose(), false);
  assert.equal(channel.call, outer);
  hook.setEnabled(true);
  const input = params();
  channel.call('storage.addid3', null, input);
  assert.equal(calls[0].args[2], input);
  assert.equal(hook.status().enabled, false);
});

test('BetterNCM onLoad reads settings; reinjection replaces the previous controller', () => {
  const callbacks = {};
  const settings = { enabled: false, captureUrls: true };
  const native = () => 7;
  const context = vm.createContext({
    channel: { call: native },
    console, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {},
    plugin: {
      onLoad(fn) { callbacks.load = fn; }, onConfig(fn) { callbacks.config = fn; },
      getConfig(key, fallback) { return settings[key] ?? fallback; },
      setConfig(key, value) { settings[key] = value; },
    },
  });
  const core = fs.readFileSync(require.resolve('../plugin/hook.js'), 'utf8');
  const main = fs.readFileSync(require.resolve('../plugin/main.js'), 'utf8');
  vm.runInContext(core + '\n' + main, context);
  assert.equal(context.channel.call, native);
  callbacks.load();
  assert.equal(context.cloudmusicNoNCM.status().enabled, false);
  assert.equal(typeof callbacks.config, 'function');
  context.cloudmusicNoNCM.setEnabled(true);
  assert.equal(settings.enabled, true);
  const old = context.cloudmusicNoNCM;
  vm.runInContext(core + '\n' + main, context);
  assert.equal(old.status().disposed, true);
  callbacks.load();
  assert.equal(context.cloudmusicNoNCM.status().enabled, true);
  assert.equal(context.cloudmusicNoNCM.dispose(), true);
  assert.equal(context.channel.call, native);
});

test('manifest Main injection files exist in the declared order', () => {
  const manifest = require('../plugin/manifest.json');
  assert.equal(manifest.manifest_version, 1);
  assert.deepEqual(manifest.injects.Main.map(x => x.file), ['hook.js', 'main.js']);
  for (const { file } of manifest.injects.Main) assert.ok(fs.existsSync(require.resolve('../plugin/' + file)));
});

test('settings expose source and feedback links through the external-browser API', async () => {
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.listeners = {}; }
    appendChild(child) { this.children.push(child); }
    append(...children) { this.children.push(...children); }
    addEventListener(event, callback) { this.listeners[event] = callback; }
  }
  const callbacks = {};
  const opened = [];
  const context = vm.createContext({
    channel: { call() {} }, console, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {},
    document: { createElement: tag => new Element(tag), createTextNode: text => ({ text }) },
    betterncm: { ncm: { openUrl: async url => { opened.push(url); } } },
    plugin: {
      onLoad(fn) { callbacks.load = fn; }, onConfig(fn) { callbacks.config = fn; },
      getConfig(key, fallback) { return fallback; }, setConfig() {},
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../plugin/hook.js'), 'utf8') + '\n' +
    fs.readFileSync(require.resolve('../plugin/main.js'), 'utf8'), context);
  callbacks.load();
  try {
    const panel = callbacks.config();
    const flatten = node => [node, ...(node.children || []).flatMap(flatten)];
    const links = flatten(panel).filter(node => node.tag === 'a');
    assert.deepEqual(links.map(link => link.textContent), ['源代码', '问题反馈']);
    let prevented = 0;
    for (const link of links) await link.listeners.click({ preventDefault() { prevented++; } });
    assert.equal(prevented, 2);
    assert.deepEqual(opened, [
      'https://github.com/Hxjjxg/cloudmusic-no-ncm-hook',
      'https://github.com/Hxjjxg/cloudmusic-no-ncm-hook/issues',
    ]);
  } finally {
    context.cloudmusicNoNCM.dispose();
  }
});
