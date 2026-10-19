// CDP harness: import { open } from './cdp.mjs'; const b = await open(query); await b.ev(expr); await b.shot(file); b.close()
import { spawn } from 'node:child_process'; import fs from 'node:fs';
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function open(query = '', port = 9241) {
  const prof = (process.env.TEMP || '/tmp') + '/riot-cdp-prof' + port;
  const cp = spawn(chrome, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--window-size=1400,900', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', 'about:blank']);
  let tabs; for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
  const page = tabs.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {};
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m.result || m); delete pend[m.id]; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type !== 'log') console.log('[console.' + m.params.type + ']', m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') console.log('[EXCEPTION]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://localhost:8080/' + query });
  for (let i = 0; i < 120; i++) { await sleep(500); const r = await send('Runtime.evaluate', { expression: '!!(window.__sim && window.__sim.sim)', returnByValue: true }); if (r.result?.value) break; }
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 600000 }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
  const shot = async file => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(s.data, 'base64')); };
  return { ev, shot, send, close: () => { ws.close(); cp.kill(); } };
}
