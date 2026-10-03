'use strict';
/**
 * A fake Ollama for the summary's tests and probe (backlog #39 job 1): the three endpoints the client touches,
 * with the failure shapes the real one has shown (a slow first answer, a model that isn't there, a reply that
 * isn't JSON). It listens on 127.0.0.1 on an OS-picked port and records every request it gets.
 *
 *   const fake = await startFakeOllama({ models: ['llama3.2:3b'] });
 *   fake.url          'http://127.0.0.1:<port>'
 *   fake.requests     [{ method, path, body }]   in arrival order (body parsed when it is JSON)
 *   fake.set({...})   change the behaviour between calls
 *   await fake.close()
 *
 * Behaviour (all mutable through `set`):
 *   rootStatus      status of GET /                         (200)
 *   rootHangFirst   hang this many GET / calls, then answer (0)
 *   tagsHangFirst   same for GET /api/tags                  (0)
 *   models          names GET /api/tags lists               (['llama3.2:3b'])
 *   tagsBody        a raw string to answer /api/tags with instead of the list
 *   generate        (body, n) => ({ status?, json?, raw?, delayMs?, hang? }) for POST /api/generate; n counts from 1
 *                   default: a three-line summary
 *
 * A "hang" never answers: the client's timeout has to be what ends it. close() destroys every open socket, so
 * a hung request can't keep the test process alive.
 */

const http = require('http');

const DEFAULT_REPLY = 'Working on: the where-are-we panel\nWhere it stands: the scheduler and the client are built\nNext: wire the host and paint the bar';

async function startFakeOllama(initial = {}) {
  const cfg = { rootStatus: 200, rootHangFirst: 0, tagsHangFirst: 0, models: ['llama3.2:3b'], tagsBody: null, generate: null, ...initial };
  const requests = [];
  const sockets = new Set();
  let rootCalls = 0;
  let tagsCalls = 0;
  let generateCalls = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (text) { try { body = JSON.parse(text); } catch { body = text; } }
      const path = req.url.split('?')[0];
      requests.push({ method: req.method, path, body });
      const send = (status, payload, raw) => {
        res.writeHead(status, { 'content-type': raw !== undefined ? 'text/plain' : 'application/json' });
        res.end(raw !== undefined ? raw : JSON.stringify(payload));
      };
      if (req.method === 'GET' && path === '/') {
        rootCalls += 1;
        if (rootCalls <= cfg.rootHangFirst) return;
        return send(cfg.rootStatus, null, 'Ollama is running');
      }
      if (req.method === 'GET' && path === '/api/tags') {
        tagsCalls += 1;
        if (tagsCalls <= cfg.tagsHangFirst) return;
        if (cfg.tagsBody !== null) return send(200, null, cfg.tagsBody);
        return send(200, { models: cfg.models.map(name => ({ name, model: name })) });
      }
      if (req.method === 'POST' && path === '/api/generate') {
        generateCalls += 1;
        const r = typeof cfg.generate === 'function' ? cfg.generate(body, generateCalls) : { json: { response: DEFAULT_REPLY, done: true } };
        if (r.hang) return;
        const go = () => (r.raw !== undefined ? send(r.status || 200, null, r.raw) : send(r.status || 200, r.json));
        if (r.delayMs) setTimeout(go, r.delayMs); else go();
        return;
      }
      send(404, { error: 'not found' });
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    set: (next) => Object.assign(cfg, next),
    count: (method, path) => requests.filter(r => r.method === method && r.path === path).length,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

module.exports = { startFakeOllama, DEFAULT_REPLY };
