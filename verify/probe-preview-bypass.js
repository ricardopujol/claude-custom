'use strict';
/**
 * PROBE: which proxy bypass list keeps ONLY the three loopback hosts direct (PR #198 Dexter r2 N1). (re-runnable)
 *
 *   env -u ELECTRON_RUN_AS_NODE node verify/probe-preview-bypass.js        (prints one line per candidate list; exit 0)
 *
 * The Preview session must load the dev server on localhost / 127.0.0.1 / [::1] DIRECT and send every other address, 127.0.0.2 and 169.254.x
 * included, to its proxy. Chromium bypasses "implicit" hosts (all of 127/8, 169.254/16, fe80::/10) unless `<-loopback>` removes them, and
 * the order of explicit entries against `<-loopback>` is not something to assume. This starts a proxy of its own (it counts what it is sent) and a
 * loopback web server, creates one in-memory session per candidate list in a real Electron, and asks each for three addresses. A hit at the
 * proxy means "proxied"; a hit at the web server means "direct".
 *
 * It runs INSIDE Electron (the file is both the launcher and the main process: run with node, it spawns itself through verify/lib/launch-electron.js,
 * which takes the heavy lock and strips the environment). Only PIDs it started are killed.
 */
const path = require('path');

if (!process.versions.electron) {
  const { spawnElectron } = require('./lib/launch-electron');
  const child = spawnElectron(require(path.join(__dirname, '..', 'node_modules', 'electron')), [__filename], { cwd: path.join(__dirname, '..') });
  child.stdout.on('data', d => process.stdout.write(d));
  child.stderr.on('data', d => process.stderr.write(d));
  child.on('exit', (code) => process.exit(code || 0));
} else {
  const { app, session, net: enet } = require('electron');
  const http = require('http');
  const net = require('net');

  const CANDIDATES = [
    ['explicit then <-loopback>', 'localhost;127.0.0.1;[::1];<-loopback>'],
    ['<-loopback> then explicit', '<-loopback>;localhost;127.0.0.1;[::1]'],
    ['no bypass rules (implicit only)', ''],
    ['<-loopback> alone', '<-loopback>'],
  ];
  const TARGETS = [
    ['localhost', (p) => `http://localhost:${p}/`],
    ['127.0.0.1', (p) => `http://127.0.0.1:${p}/`],
    ['127.0.0.2', (p) => `http://127.0.0.2:${p}/`],
    ['169.254.10.20', () => 'http://169.254.10.20:80/'],
    ['203.0.113.7', () => 'http://203.0.113.7:80/'],
  ];

  app.whenReady().then(async () => {
    const proxied = [];
    const direct = [];
    const proxy = net.createServer((sock) => {
      sock.once('data', (d) => { proxied.push(String(d).split('\r\n')[0]); sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
      sock.on('error', () => {});
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    const web = http.createServer((q, res) => { direct.push(`${q.headers.host}`); res.end('ok'); });
    await new Promise(r => web.listen(0, '0.0.0.0', r));
    const proxyPort = proxy.address().port;
    const webPort = web.address().port;
    let n = 0;
    for (const [label, rules] of CANDIDATES) {
      const ses = session.fromPartition(`bypass-probe-${n++}`);
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${proxyPort}`, ...(rules ? { proxyBypassRules: rules } : {}) });
      const verdicts = {};
      for (const [name, make] of TARGETS) {
        proxied.length = 0; direct.length = 0;
        const url = make(webPort);
        await new Promise((resolve) => {
          const req = enet.request({ url, session: ses });
          const done = () => { clearTimeout(t); resolve(); };
          const t = setTimeout(() => { try { req.abort(); } catch { /* done */ } resolve(); }, 3000);
          req.on('response', () => { done(); });
          req.on('error', () => { done(); });
          req.end();
        });
        verdicts[name] = proxied.length ? 'PROXY' : (direct.length ? 'direct' : 'none');
      }
      console.log(`${label.padEnd(34)} ${JSON.stringify(verdicts)}`);
    }
    proxy.close(); web.close();
    app.exit(0);
  });
}
