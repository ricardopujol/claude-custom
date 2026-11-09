'use strict';
/**
 * A stand-in for a tab's host that NEVER answers a stop (verify/probe-tab-close-kept.js, BACKLOG #129).
 *
 *   node verify/lib/stubborn-host.js <port> [older|silent]
 *
 *   older   (default) the hello lists no `stop` control, like a host of older code: the shell's stop fails AT ONCE
 *   silent  the hello lists it, the frame is taken and never answered: the stop times out
 *
 * It listens on 127.0.0.1:<port> as a WebSocket server, says hello the way a host does (listing the controls it takes, so
 * host/host-client.js sends its `stop` frame), and then ignores every frame and never closes a socket: the shell's stop times
 * out, which is the case the kept tab is for. It runs no pty and writes no identity file: the probe writes that, with the
 * pid and start time it chooses. Ends only when something kills its pid.
 */
const { WebSocketServer } = require('ws');

const port = Number(process.argv[2]);
const mode = process.argv[3] === 'silent' ? 'silent' : 'older';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('usage: node verify/lib/stubborn-host.js <port>');
  process.exit(2);
}

const wss = new WebSocketServer({ host: '127.0.0.1', port });
wss.on('connection', (ws) => {
  ws.on('error', () => { /* a client leaving is not our business */ });
  try { ws.send(JSON.stringify({ type: 'hello', controls: mode === 'silent' ? ['raise', 'stop', 'stop-if-idle'] : ['raise'] })); } catch { /* gone */ }
  ws.on('message', () => { /* ignored: a stop is never answered */ });
});
wss.on('listening', () => console.log(`[stubborn-host] pid ${process.pid} listening on ${port}`));
wss.on('error', (err) => { console.error(`[stubborn-host] ${err && err.message}`); process.exit(1); });
