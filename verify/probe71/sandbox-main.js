'use strict';
/**
 * Electron main for verify/probe-canvas-sandbox.js. It runs the REAL Claude's-panel code (app/canvas-views.js,
 * app/canvas-panel-preload.js, app/canvas-csp.js, app/canvas-fetch.js) and runs ONE escape attempt per panel.
 *
 * Every network vector gets its OWN denied server on its own loopback port, so a hit is attributed to exactly the vector
 * that caused it: `requests` (an HTTP request arrived) and `connections` (a TCP connection opened, which is all a preconnect
 * or a TURN-over-TCP attempt makes). WebRTC is counted on a UDP socket (STUN) and a TCP server (TURN). DNS is read from a
 * Chromium net-log, looking for made-up host names. A panel reports its result by setting its title.
 *
 * PROBE_MODE=sealed (default): the panel as the app builds it, with the process-wide resolver rule the app sets.
 * PROBE_MODE=naive: a panel with NONE of that (a default session, no dead proxy, no navigation guard, no resolver rule).
 *   It is the CONTROL: it must show the leaks, or a quiet "sealed" run could just mean the probe cannot see a leak.
 * PROBE_OUT=<file> where the JSON goes.
 */
const { app, BrowserWindow, WebContentsView, ipcMain, netLog, session } = require('electron');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCanvasViews, registerCanvasIpc, HOST_RESOLVER_RULES } = require('../../app/canvas-views');
const { buildPage } = require('../../app/canvas-csp');

const MODE = process.env.PROBE_MODE === 'naive' ? 'naive' : 'sealed';
const OUT = process.env.PROBE_OUT;
const PRELOAD = path.join(__dirname, '..', '..', 'app', 'canvas-panel-preload.js');
const DNS_HOST = `dnsprobe-${process.pid}.invalid`;
// The same switch app/main.js sets, before ready. The naive control leaves it out.
if (MODE === 'sealed') app.commandLine.appendSwitch('host-resolver-rules', HOST_RESOLVER_RULES);

// One entry per path out of the sandbox. `code` runs in the panel with V (the vector), A (the approved server's URL),
// D(), the URL of THIS vector's denied server, and report(x).
const VECTORS = {
  // --- the approved path works: the control that proves a hit can be seen --------------------------------------------
  'fetch-approved (control)': { code: `fetch(A + '?v=' + V).then(r => report(r.status), e => report('blocked ' + e.message))` },
  // --- network the page may not have -----------------------------------------------------------------------------------
  'fetch-denied-host (broker)': { code: `fetch(D()).then(r => report(r.status), e => report('blocked ' + e.message))` },
  'fetch-redirect-offsite (broker)': { code: `fetch(A + 'redirect?to=' + encodeURIComponent(D())).then(r => report(r.status), e => report('blocked ' + e.message))` },
  'fetch-fresh-realm (raw)': { code: `const f = document.createElement('iframe'); document.body.appendChild(f); f.contentWindow.fetch(D()).then(r => report(r.status), e => report('blocked ' + e.name))` },
  'fetch-no-cors': { code: `const f = document.createElement('iframe'); document.body.appendChild(f); f.contentWindow.fetch(D(), { mode: 'no-cors' }).then(() => report('sent'), e => report('blocked ' + e.name))` },
  'xhr': { code: `const x = new XMLHttpRequest(); x.open('GET', D()); x.onerror = () => report('blocked'); x.onload = () => report(x.status); x.send()` },
  'websocket': { code: `try { const w = new WebSocket(D().replace('http', 'ws')); w.onerror = () => report('blocked'); w.onopen = () => report('open'); } catch (e) { report('blocked ' + e.name); }` },
  'eventsource': { code: `try { const s = new EventSource(D()); s.onerror = () => report('blocked'); s.onopen = () => report('open'); } catch (e) { report('blocked ' + e.name); }` },
  'send-beacon': { code: `report(String(navigator.sendBeacon(D(), 'x')))` },
  'image': { code: `const i = new Image(); i.onerror = () => report('blocked'); i.onload = () => report('loaded'); i.src = D()` },
  'script-tag': { code: `const s = document.createElement('script'); s.src = D(); s.onerror = () => report('blocked'); s.onload = () => report('loaded'); document.head.appendChild(s)` },
  'stylesheet-link': { code: `const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = D(); l.onerror = () => report('blocked'); l.onload = () => report('loaded'); document.head.appendChild(l)` },
  'css-url': { code: `document.head.insertAdjacentHTML('beforeend', '<style>body{background:url(' + D() + ')}</style>'); setTimeout(() => report('css set'), 300)` },
  'font-face': { code: `document.head.insertAdjacentHTML('beforeend', '<style>@font-face{font-family:x;src:url(' + D() + ')}body{font-family:x}</style>'); setTimeout(() => report('css set'), 300)` },
  'video': { code: `const v = document.createElement('video'); v.onerror = () => report('blocked'); v.src = D(); document.body.appendChild(v); setTimeout(() => report('timeout'), 500)` },
  'object-tag': { code: `document.body.insertAdjacentHTML('beforeend', '<object data="' + D() + '"></object>'); setTimeout(() => report('set'), 300)` },
  'nested-iframe': { code: `document.body.insertAdjacentHTML('beforeend', '<iframe src="' + D() + '"></iframe>'); setTimeout(() => report('set'), 500)` },
  'dynamic-import': { code: `import(D()).then(() => report('loaded'), e => report('blocked ' + e.name))` },
  'worker': { code: `try { const w = new Worker(D()); w.onerror = () => report('blocked'); } catch (e) { report('blocked ' + e.name); }` },
  'service-worker': { code: `navigator.serviceWorker ? navigator.serviceWorker.register(D()).then(() => report('registered'), e => report('blocked ' + e.name)) : report('no serviceWorker')` },
  'anchor-ping': { code: `document.body.insertAdjacentHTML('beforeend', '<a id="p" href="#x" ping="' + D() + '">p</a>'); document.getElementById('p').click(); setTimeout(() => report('clicked'), 500)` },
  // --- resource hints: a CSP does not always cover them ----------------------------------------------------------------------
  'preconnect': { code: `const l = document.createElement('link'); l.rel = 'preconnect'; l.href = D(); document.head.appendChild(l); setTimeout(() => report('hint set'), 800)` },
  'prefetch': { code: `const l = document.createElement('link'); l.rel = 'prefetch'; l.href = D(); document.head.appendChild(l); setTimeout(() => report('hint set'), 800)` },
  'modulepreload': { code: `const l = document.createElement('link'); l.rel = 'modulepreload'; l.href = D(); document.head.appendChild(l); setTimeout(() => report('hint set'), 800)` },
  'dns-prefetch': { code: `const l = document.createElement('link'); l.rel = 'dns-prefetch'; l.href = 'https://${DNS_HOST}/'; document.head.appendChild(l); setTimeout(() => report('hint set'), 1500)` },
  'dns-prefetch-meta-on': { code: `document.head.insertAdjacentHTML('afterbegin', '<meta http-equiv="x-dns-prefetch-control" content="on">'); const l = document.createElement('link'); l.rel = 'dns-prefetch'; l.href = 'https://re-${DNS_HOST}/'; document.head.appendChild(l); setTimeout(() => report('hint set'), 1500)` },
  'dns-preconnect': { code: `const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'https://pc-${DNS_HOST}/'; document.head.appendChild(l); setTimeout(() => report('hint set'), 1500)` },
  // --- WebRTC and friends: they ignore CSP -----------------------------------------------------------------------------------
  'webrtc-stun-udp': { code: `try { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:' + LAN + ':' + UDP }] }); pc.createDataChannel('x'); pc.createOffer().then(o => pc.setLocalDescription(o)); setTimeout(() => report('gathering'), 2500); } catch (e) { report('blocked ' + e.name); }` },
  'webrtc-turn-tcp-loopback': { code: `try { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:127.0.0.1:' + TCP + '?transport=tcp', username: 'u', credential: 'c' }], iceTransportPolicy: 'relay' }); pc.createDataChannel('x'); pc.createOffer().then(o => pc.setLocalDescription(o)); setTimeout(() => report('gathering'), 2500); } catch (e) { report('blocked ' + e.name); }` },
  'webtransport': { code: `try { const t = new WebTransport('https://127.0.0.1:' + UDP + '/'); t.ready.then(() => report('open'), e => report('blocked ' + e.name)); setTimeout(() => report('timeout'), 1500); } catch (e) { report('blocked ' + e.name); }` },
  // --- navigation: CSP has no navigate-to ----------------------------------------------------------------------------------------
  'self-location-href': { code: `setTimeout(() => report('navigating'), 50); location.href = D()` },
  'self-location-replace': { code: `setTimeout(() => report('navigating'), 50); location.replace(D())` },
  'meta-refresh': { code: `document.head.insertAdjacentHTML('beforeend', '<meta http-equiv="refresh" content="0;url=' + D() + '">'); setTimeout(() => report('meta set'), 1200)` },
  'anchor-click-self': { code: `document.body.insertAdjacentHTML('beforeend', '<a id="a" href="' + D() + '">a</a>'); setTimeout(() => report('clicked'), 50); document.getElementById('a').click()` },
  'anchor-click-blank': { code: `document.body.insertAdjacentHTML('beforeend', '<a id="a" target="_blank" href="' + D() + '">a</a>'); setTimeout(() => report('clicked'), 50); document.getElementById('a').click()` },
  'form-post': { code: `document.body.insertAdjacentHTML('beforeend', '<form id="f" method="post" action="' + D() + '"></form>'); setTimeout(() => report('submitted'), 50); document.getElementById('f').submit()` },
  'form-get-blank': { code: `document.body.insertAdjacentHTML('beforeend', '<form id="f" target="_blank" action="' + D() + '"></form>'); setTimeout(() => report('submitted'), 50); document.getElementById('f').submit()` },
  'window-open': { code: `report(String(window.open(D())))` },
  'top-location': { code: `try { window.top.location.href = D(); report('no throw'); } catch (e) { report('blocked ' + e.name); }` },
  // --- reach into the app, no network involved --------------------------------------------------------------------------------------
  'app-bridge': { code: `report([typeof window.harness, typeof window.hostBridge, typeof window.require, typeof window.process, typeof window.electron].join('/'))` },
  'bridge-surface': { code: `report(Object.keys(window.claudePanel || {}).sort().join(','))` },
  'clipboard-read': { code: `navigator.clipboard ? navigator.clipboard.readText().then(t => report('read: ' + t), e => report('blocked ' + e.name)) : report('no clipboard api')` },
  'local-storage': { code: `try { localStorage.setItem('k', '1'); report('wrote'); } catch (e) { report('blocked ' + e.name); }` },
  'cookie': { code: `try { document.cookie = 'k=1'; report('set, reads back: ' + document.cookie); } catch (e) { report('blocked ' + e.name); }` },
  'indexed-db': { code: `try { const r = indexedDB.open('x'); r.onsuccess = () => report('opened'); r.onerror = () => report('blocked'); } catch (e) { report('blocked ' + e.name); }` },
  'geolocation-camera': { code: `Promise.allSettled([navigator.geolocation ? new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej)) : Promise.reject('none'), navigator.mediaDevices ? navigator.mediaDevices.getUserMedia({ video: true }) : Promise.reject('none')]).then(r => report(r.map(x => x.status).join('/')))` },
  // --- the page's own dialogs: a native message box parented to the app's window (PR #122 Dexter F1) -----------------------------------
  'dialog-loop': { code: `alert('a'); confirm('b'); try { prompt('c'); } catch (e) { /* Electron has no prompt() */ } setTimeout(() => report('past the dialogs'), 300)` },
  // --- a download the page starts itself: Electron's default is a Save-As box with a name and content the page chose (PR #122 Dexter F2)
  // (once from a script on load, and once more on a real click, so a download that needs a user gesture is seen too)
  'data-download': { code: `const dl = () => { const a = document.createElement('a'); a.href = 'data:application/octet-stream;base64,QGVjaG8gb2Zm'; a.download = 'claude-quota-fix.bat'; document.body.appendChild(a); a.click(); };
    document.body.innerHTML = '<div style="position:fixed;left:0;top:0;width:300px;height:200px">x</div>'; dl(); document.addEventListener('click', dl); setTimeout(() => report('clicked'), 2500)` },
  // --- a page that refuses to be left: its beforeunload handler cancels Claude's NEXT page (PR #122 Dexter F3). Phase one is this page and a
  // real click (sticky user activation, which is what lets beforeunload act); phase two (SECOND_PAGES) is the page Claude writes next.
  'beforeunload-pin': { code: `document.body.innerHTML = '<div style="position:fixed;left:0;top:0;width:300px;height:200px">x</div>'; onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ''; return ''; }; document.addEventListener('click', () => report('armed'))` },
  // --- the one thing the page may do: a button ----------------------------------------------------------------------------------------
  'send-without-click': { code: `claudePanel.send('typed by a script'); setTimeout(() => report('sent'), 300)` },
  'send-with-click': { code: `document.body.innerHTML = '<button id="b" style="position:fixed;left:0;top:0;width:200px;height:100px">go</button>'; document.getElementById('b').addEventListener('click', () => { claudePanel.send('hello from a click'); report('clicked'); });` },
};
const SECOND_PAGES = { 'beforeunload-pin': `report('replaced')` };
const NAMES = Object.keys(VECTORS).filter(n => !process.env.PROBE_ONLY || process.env.PROBE_ONLY.split('|').includes(n));

// A STUN server on the machine's LAN address too: Chromium may not send STUN to loopback, and a control that cannot see a
// leak proves nothing. Falls back to loopback on a machine with no other address.
const LAN = (Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal) || { address: '127.0.0.1' }).address;
const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));

app.whenReady().then(async () => {
  const netlogFile = path.join(os.tmpdir(), `probe-canvas-netlog-${process.pid}.json`);
  await netLog.startLogging(netlogFile, { captureMode: 'everything' });

  const hits = {}; const ports = {}; const servers = [];
  const count = (name) => hits[name] || (hits[name] = { requests: 0, connections: 0 });
  for (const n of NAMES) {
    const rec = count(n);
    const s = http.createServer((q, res) => { rec.requests += 1; res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('pong'); });
    s.on('connection', () => { rec.connections += 1; });
    ports[n] = await listen(s); servers.push(s);
  }
  const allowedRec = { requests: 0 };
  const approvedSrv = http.createServer((q, res) => {
    allowedRec.requests += 1;
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/redirect') { res.writeHead(302, { location: u.searchParams.get('to') }); res.end(); return; }
    res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('pong');
  });
  const approvedPort = await listen(approvedSrv); servers.push(approvedSrv);
  const approvedOrigin = `http://127.0.0.1:${approvedPort}`;

  const rtc = { stunDatagrams: 0, turnTcpConnections: 0 };
  const udp = dgram.createSocket('udp4'); udp.on('message', () => { rtc.stunDatagrams += 1; });
  await new Promise(r => udp.bind(0, '0.0.0.0', r));
  const tcp = net.createServer((sock) => { rtc.turnTcpConnections += 1; sock.destroy(); });
  const tcpPort = await listen(tcp);

  const owner = new BrowserWindow({ show: false, width: 1000, height: 800 });
  await owner.loadURL('data:text/html,<p>owner</p>');
  let windowOpens = 0; const navAttempts = []; const delivered = []; const asked = []; const downloads = [];
  owner.webContents.setWindowOpenHandler(() => { windowOpens += 1; return { action: 'deny' }; });
  owner.webContents.on('will-navigate', (_e, url) => navAttempts.push(url));
  const panels = new Map();   // owner id -> the panel contents the manager made for it, to read titles from

  const views = createCanvasViews({
    WebContentsView: class extends WebContentsView { constructor(o) { super(o); panels.set(Number(/^canvas-([0-9]+)-/.exec(o.webPreferences.partition)[1]), this.webContents); } },
    session,
    addChild: (v) => owner.contentView.addChildView(v), removeChild: (v) => owner.contentView.removeChildView(v),
    ownerBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    preloadPath: PRELOAD,
    ask: async (o, origin) => { asked.push(origin); return 'deny'; },
    onMessage: (o, msg) => delivered.push(msg),
    log: () => {},
  });
  registerCanvasIpc(ipcMain, views);

  const pageFor = (name, code) => {
    const v = { code: code || VECTORS[name].code };
    const key = name.replace(' (control)', '');
    return `<script>
      const V = ${JSON.stringify(key)}, A = ${JSON.stringify(approvedOrigin + '/')}, UDP = ${udp.address().port}, TCP = ${tcpPort}, LAN = ${JSON.stringify(LAN)};
      const D = () => 'http://127.0.0.1:${ports[name]}/?v=' + encodeURIComponent(V);
      const report = (r) => { document.title = 'R:' + JSON.stringify(String(r)); };
      try { ${v.code} } catch (e) { report('threw ' + e.name); }
    <\/script>`;
  };

  const results = {};
  async function runOne(name) {
    const html = pageFor(name);
    let wc; let fakeOwner = null; let naiveView = null;
    if (MODE === 'sealed') {
      fakeOwner = { id: 1000 + NAMES.indexOf(name), isDestroyed: () => false };
      const approved = name === 'fetch-approved (control)' || name.startsWith('fetch-redirect') ? [approvedOrigin] : [];
      await views.show(fakeOwner, { html, hosts: { approved, denied: [] }, rect: { x: 0, y: 0, width: 400, height: 300 } });
      wc = panels.get(fakeOwner.id);
      // A download the panel's own lock-down did not cancel would raise a Save-As box: save it to a temp file instead, and record it.
      wc.session.on('will-download', (e, item) => {
        const rec = { name: item.getFilename(), prevented: e.defaultPrevented === true, written: false };
        downloads.push(rec);
        if (!rec.prevented) { rec.file = path.join(os.tmpdir(), `probe-canvas-dl-${process.pid}-${downloads.length}`); item.setSavePath(rec.file); item.once('done', () => { rec.written = fs.existsSync(rec.file); try { fs.unlinkSync(rec.file); } catch { /* none */ } }); }
      });
    } else {
      // The control: the same page and preload, but a default session and nothing locked.
      naiveView = new WebContentsView({ webPreferences: { sandbox: process.env.PROBE_NAIVE_SANDBOX !== '0', contextIsolation: true, nodeIntegration: false, preload: PRELOAD } });
      owner.contentView.addChildView(naiveView);
      naiveView.setBounds({ x: 0, y: 0, width: 400, height: 300 });
      wc = naiveView.webContents;
      wc.setWindowOpenHandler(() => { windowOpens += 1; return { action: 'deny' }; });
      wc.loadURL('data:text/html;base64,' + Buffer.from(buildPage(html), 'utf8').toString('base64'));
    }
    results[name] = await new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      wc.on('page-title-updated', (_e, title) => { if (title.startsWith('R:')) finish(JSON.parse(title.slice(2))); });
      setTimeout(() => finish('no report'), 5000);
      if (name === 'send-with-click' || name === 'data-download' || name === 'beforeunload-pin') {
        setTimeout(() => { for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: 30, y: 30, button: 'left', clickCount: 1 }); }, 1200);
      }
    });
    if (SECOND_PAGES[name] && MODE === 'sealed' && results[name] === 'armed') {
      results[name] = await new Promise((resolve) => {
        const t = setTimeout(() => resolve('stuck on the first page'), 4000);
        wc.on('page-title-updated', (_e, title) => { if (title === 'R:"replaced"') { clearTimeout(t); resolve('replaced'); } });
        views.show(fakeOwner, { html: pageFor(name, SECOND_PAGES[name]), hosts: { approved: [], denied: [] }, rect: { x: 0, y: 0, width: 400, height: 300 } });
      });
    }
    await new Promise(r => setTimeout(r, 400));        // a straggler request gets its moment to arrive
    if (MODE === 'sealed') views.hide(fakeOwner);
    else { try { owner.contentView.removeChildView(naiveView); naiveView.webContents.close(); } catch { /* gone */ } }
  }

  const BATCH = 4;
  for (let i = 0; i < NAMES.length; i += BATCH) await Promise.all(NAMES.slice(i, i + BATCH).map(runOne));
  await new Promise(r => setTimeout(r, 1200));

  await netLog.stopLogging();
  const dnsKinds = new Set(); let dnsQueries = 0;
  try {
    const log = JSON.parse(fs.readFileSync(netlogFile, 'utf8'));
    const T = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]));
    for (const e of log.events) {
      if (T[e.type] !== 'DNS_TRANSACTION_QUERY') continue;
      const q = String((e.params && e.params.qname) || '');
      if (q.includes('dnsprobe-')) { dnsQueries += 1; dnsKinds.add(q.startsWith('re-') ? 'dns-prefetch-meta-on' : q.startsWith('pc-') ? 'dns-preconnect' : 'dns-prefetch'); }
    }
  } catch { dnsQueries = -1; }
  const out = { electron: process.versions.electron, chrome: process.versions.chrome, mode: MODE, results, names: NAMES,
    hits, approvedHits: allowedRec.requests, rtc, dns: { queries: dnsQueries, kinds: [...dnsKinds] }, windowOpens,
    ownerNavigations: navAttempts, delivered, asked: [...new Set(asked)], downloads };
  const text = JSON.stringify(out);
  if (OUT) fs.writeFileSync(OUT, text); else console.log('RESULT ' + text);
  try { fs.unlinkSync(netlogFile); } catch { /* temp */ }
  servers.forEach(s => s.close()); udp.close(); tcp.close();
  app.exit(0);
});
setTimeout(() => { console.log('FAIL timeout'); app.exit(2); }, 240000);
