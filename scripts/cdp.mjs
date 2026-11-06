// Node.js 22+. Connect directly to the CEF page; no browser Target APIs required.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const [command = 'status', ...args] = process.argv.slice(2);
const commands = new Set(['list', 'install', 'uninstall', 'status', 'export', 'enable', 'disable']);
if (!commands.has(command)) throw new Error('Commands: list, install, uninstall, status, export [file], enable, disable');
const endpoint = process.env.CDP_URL || 'http://127.0.0.1:9222';
const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error(`Target discovery failed: HTTP ${response.status}`);
const targets = await response.json();
if (command === 'list') {
  console.log(JSON.stringify(targets.map(({ id, title, url }) => ({ id, title, url })), null, 2));
  process.exit(0);
}
const matches = targets.filter(target => process.env.CDP_TARGET
  ? target.id.startsWith(process.env.CDP_TARGET)
  : /^orpheus:\/\/orpheus\/pub\/app\.html(?:[?#]|$)/.test(target.url));
if (matches.length !== 1) throw new Error(`Expected one page, found ${matches.length}. Set CDP_TARGET to an ID from list.`);
const ws = new WebSocket(matches[0].webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
const timeout = setTimeout(() => {
  console.error('CDP timed out after 15 seconds');
  ws.close();
  process.exit(1);
}, 15000);
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const job = pending.get(message.id);
  if (!job) return;
  pending.delete(message.id);
  message.error ? job.reject(new Error(JSON.stringify(message.error))) : job.resolve(message.result);
});
function send(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
try {
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  if (command === 'install') {
    const core = await readFile(new URL('../plugin/hook.js', import.meta.url), 'utf8');
    const main = await readFile(new URL('../plugin/main.js', import.meta.url), 'utf8');
    await evaluate(`(() => {\n${core}\n${main}\n})()`);
  }
  let value;
  if (command === 'uninstall') {
    value = await evaluate('globalThis.cloudmusicNoNCM ? {restored:cloudmusicNoNCM.dispose(),status:cloudmusicNoNCM.status()} : {installed:false}');
  } else if (command === 'export') {
    const records = await evaluate('globalThis.cloudmusicNoNCM ? cloudmusicNoNCM.getRecords() : []');
    const file = args[0] || 'captures/download-records.json';
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(records, null, 2));
    value = { file, records: records.length };
  } else {
    if (command === 'enable' || command === 'disable') {
      await evaluate(`(() => {if(!globalThis.cloudmusicNoNCM)throw Error('Run install first');cloudmusicNoNCM.setEnabled(${command === 'enable'});})()`);
    }
    value = await evaluate('globalThis.cloudmusicNoNCM ? cloudmusicNoNCM.status() : {installed:false}');
  }
  console.log(JSON.stringify(value, null, 2));
} finally {
  clearTimeout(timeout);
  ws.close();
}
