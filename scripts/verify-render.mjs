#!/usr/bin/env node
/**
 * Drive the real app in a real browser and report what it actually renders.
 *
 * A lighting visualiser cannot be verified by a unit test — "does the beam look
 * right" is a question about pixels. This launches Chrome against the dev
 * server, feeds it a real MVR through the app's own file input, and reports the
 * live counters plus a screenshot.
 *
 * Why Chrome over CDP rather than the editor's browser pane: **a page that is
 * not being composited does not run `requestAnimationFrame`**. A hidden or
 * backgrounded tab reports 0 fps, 0 beams and 0 draw calls no matter how well
 * the renderer works, which reads exactly like a dead render loop. The flags
 * below are the ones that keep a non-frontmost Chrome ticking.
 *
 * The MVR goes in through `DOM.setFileInputFiles`, so the app's own code path
 * runs unmodified — a real `File`, a real `arrayBuffer()`, the real parser.
 *
 * Usage:
 *   node scripts/verify-render.mjs [--url URL] [--mvr PATH] [--out PATH]
 *                                  [--headless] [--settle MS]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9224; // not 9222/9223: those may still hold a Chrome from a video shoot

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

/** Locate MA's Demostage inside an installed grandMA3. */
function findDemostage() {
  const root = join(homedir(), 'MALightingTechnology');
  if (!existsSync(root)) return undefined;
  for (const version of readdirSync(root)) {
    const candidate = join(root, version, 'shared/resource/lib_mvr/Demostage_MVR.mvr');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const url = arg('url', 'http://localhost:5219');
const mvr = arg('mvr', findDemostage());
const out = arg('out', 'render-check.png');
const settle = Number(arg('settle', '9000'));

if (!mvr || !existsSync(mvr)) {
  console.error('No MVR found. Pass --mvr PATH (grandMA3 ships Demostage_MVR.mvr).');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'simplevis-verify-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1600,1000',
    // Without these three, Chrome suspends rAF whenever its window is not the
    // frontmost application — which it never is during an automated run.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...(has('headless') ? ['--headless=new'] : []),
    url,
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return res.json();
}

/** Wait for the page target that is actually our app, not the blank one. */
async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await targets();
      const page = list.find((t) => t.type === 'page' && t.url.includes(new URL(url).host));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* Chrome not up yet */
    }
    await sleep(500);
  }
  throw new Error('no page target matching ' + url);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const resolver = this.pending.get(msg.id);
      if (resolver) {
        this.pending.delete(msg.id);
        msg.error ? resolver.reject(new Error(JSON.stringify(msg.error))) : resolver.resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.result?.description ?? ''));
    return r.result.value;
  }
}

async function main() {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.enable');

  // Wait for the app itself, not merely for a document — a target exists at
  // navigation commit, before the bundle has run.
  for (let i = 0; i < 60; i++) {
    if (await cdp.eval(`!!document.querySelector('input[type=file]')`)) break;
    await sleep(500);
  }

  // Feed the MVR through the app's own input, unmodified.
  const present = await cdp.eval(
    `JSON.stringify({inputs: document.querySelectorAll('input[type=file]').length, root: !!document.querySelector('#root')?.children.length, title: document.title})`,
  );
  console.log('page state     :', present);

  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const node = await cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'input[type=file]',
  });
  if (!node.nodeId) throw new Error('file input not found (page state above)');
  await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [mvr] });

  console.log(`fed ${mvr}`);
  await sleep(settle);

  const status = await cdp.eval(
    `document.querySelector('.statusbar')?.innerText.replace(/\\n/g, ' | ') ?? '(no status bar)'`,
  );
  const controls = await cdp.eval(
    `JSON.stringify([...document.querySelectorAll('input[type=range]')].map(i => i.value))`,
  );
  console.log('look controls  :', controls);

  const errors = await cdp.eval(
    `JSON.stringify((window.__errs ?? []).slice(0, 5))`,
  );

  // Sample the fps counter a second time so a one-off stall is visible.
  await sleep(2000);
  const status2 = await cdp.eval(
    `document.querySelector('.statusbar')?.innerText.replace(/\\n/g, ' | ') ?? '(none)'`,
  );

  console.log('status @settle :', status);
  console.log('status +2s     :', status2);
  if (errors && errors !== '[]') console.log('page errors    :', errors);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('screenshot     :', out);

  ws.close();
}

main()
  .catch((err) => {
    console.error('verify failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    chrome.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  });
