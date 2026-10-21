// Headless smoke test: node tools/smoke.mjs [waitMs] [out.png] [query] [js]
// Env: PORT (dev server, default 8080), CDP_PORT (Chrome debug port, default 9223); use distinct values per worktree.
import { spawn } from 'node:child_process'; import fs from 'node:fs';
const wait = +(process.argv[2] || 12000), out = process.argv[3] || 'shot.png';
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = +process.env.PORT || 8080, CDP = +process.env.CDP_PORT || 9223;
const prof = process.env.TEMP + '/riot-smoke-prof-' + CDP;
const cp = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + CDP, '--user-data-dir=' + prof, '--window-size=1400,900', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', 'about:blank']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tabs; for (let i = 0; i < 40; i++) { try { tabs = await (await fetch('http://127.0.0.1:' + CDP + '/json')).json(); break; } catch { await sleep(250); } }
const page = tabs.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m.result || m); delete pend[m.id]; }
  if (m.method === 'Runtime.consoleAPICalled') console.log('[console.' + m.params.type + ']', m.params.args.map(a => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') console.log('[EXCEPTION]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Log.entryAdded') console.log('[log.' + m.params.entry.level + ']', m.params.entry.text, m.params.entry.url || ''); };
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'http://localhost:' + PORT + '/' + (process.argv[4] || '') });
await sleep(wait);
const r = await send('Runtime.evaluate', { expression: process.argv[5] || 'document.getElementById("stats")?.innerText + " | " + document.getElementById("clock")?.innerText + " | loading:" + document.getElementById("loading").style.display', returnByValue: true });
console.log('[eval]', JSON.stringify(r.result?.value));
const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out, Buffer.from(s.data, 'base64'));
ws.close(); cp.kill(); process.exit(0);
