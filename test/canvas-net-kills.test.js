'use strict';
/**
 * Kill tests for the release-gate survivors S1-S3 in app/canvas-net.js (Mortimer, 2026-10-09). The transport stubs `http` and `https`
 * so the options handed to `request` can be read, and the `lookup` the connection would call is called here.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { isPublicAddress, createPinnedFetch } = require('../app/canvas-net');

/** A stand-in for http/https: records every request's options and hands back a request that does nothing. */
function stubModule(name, log) {
  return {
    request(options, onResponse) {
      const req = new EventEmitter();
      req.write = () => {}; req.end = () => {};
      log.push({ module: name, options, onResponse, req });
      return req;
    },
  };
}
function rig() {
  const log = [];
  return { log, fetch: createPinnedFetch({ http: stubModule('http', log), https: stubModule('https', log) }) };
}
const lookup = (options, opts) => new Promise((resolve) => {
  const run = (...args) => resolve(args);
  if (typeof opts === 'function') options.lookup('example.com', run); else options.lookup('example.com', opts, run);
});

test('S1: the lookup the connection calls answers with the pinned address, as one answer or as a list', async () => {
  const { log, fetch } = rig();
  fetch('http://example.com/', { pin: { address: '93.184.216.34', family: 4 } }).catch(() => {});
  const { options } = log[0];
  assert.deepStrictEqual(await lookup(options, {}), [null, '93.184.216.34', 4]);
  assert.deepStrictEqual(await lookup(options, { all: true }), [null, [{ address: '93.184.216.34', family: 4 }]]);
  assert.deepStrictEqual(await lookup(options, { all: false }), [null, '93.184.216.34', 4]);
  assert.deepStrictEqual(await lookup(options, undefined), [null, '93.184.216.34', 4], 'the callback may be the second argument');
  assert.deepStrictEqual(await lookup(options, null), [null, '93.184.216.34', 4], 'a null options argument is not read');
});

test('S1: an IPv6 pin is accepted and is what the lookup answers with', async () => {
  const { log, fetch } = rig();
  fetch('http://example.com/', { pin: { address: '2606:4700:4700::1111', family: 6 } }).catch(() => {});
  assert.strictEqual(log.length, 1, 'a family-6 pin is a valid pin');
  assert.deepStrictEqual(await lookup(log[0].options, {}), [null, '2606:4700:4700::1111', 6]);
  assert.deepStrictEqual(await lookup(log[0].options, { all: true }), [null, [{ address: '2606:4700:4700::1111', family: 6 }]]);
});

test('S1: a response the Response class refuses rejects the promise and destroys the response', async () => {
  const { log, fetch } = rig();
  const p = fetch('http://example.com/', { pin: { address: '93.184.216.34', family: 4 } });
  let destroyed = 0;
  const res = new EventEmitter();
  Object.assign(res, { statusCode: 200, statusMessage: 'bad\nreason', headers: {}, destroy() { destroyed++; }, resume() {}, pipe() { return res; } });
  log[0].onResponse(res);
  await assert.rejects(p);
  assert.strictEqual(destroyed, 1);
});

test('S3: https URLs go through the https module, http URLs through http, anything else is refused', async () => {
  const { log, fetch } = rig();
  fetch('https://example.com/a?b=1', { pin: { address: '93.184.216.34', family: 4 } }).catch(() => {});
  fetch('http://example.com/', { pin: { address: '93.184.216.34', family: 4 } }).catch(() => {});
  assert.deepStrictEqual(log.map(l => l.module), ['https', 'http']);
  await assert.rejects(() => fetch('ftp://example.com/', { pin: { address: '93.184.216.34', family: 4 } }), /only http/);
  await assert.rejects(() => fetch('file:///etc/passwd', { pin: { address: '93.184.216.34', family: 4 } }), /only http/);
  assert.strictEqual(log.length, 2);
});

test('S3: the TLS options name the host (certificate checked for the name), not the pinned address', () => {
  const { log, fetch } = rig();
  fetch('https://example.com/a?b=1', { pin: { address: '93.184.216.34', family: 4 } }).catch(() => {});
  fetch('http://example.com/', { pin: { address: '93.184.216.34', family: 4 } }).catch(() => {});
  fetch('https://example.com:8443/', { pin: { address: '93.184.216.34', family: 4 } }).catch(() => {});
  fetch('https://93.184.216.34/', { pin: { address: '93.184.216.34', family: 4 } }).catch(() => {});
  const [tls, plain, tlsPort, tlsIp] = log.map(l => l.options);
  assert.strictEqual(tls.protocol, 'https:');
  assert.strictEqual(tls.hostname, 'example.com');
  assert.strictEqual(tls.servername, 'example.com');
  assert.strictEqual(tls.port, 443);
  assert.strictEqual(tls.path, '/a?b=1');
  assert.strictEqual(plain.protocol, 'http:');
  assert.strictEqual(plain.port, 80);
  assert.strictEqual(tlsPort.port, '8443');
  assert.strictEqual(tlsIp.servername, undefined, 'an IP literal is no TLS server name');
});

test('S2: a mapped-IPv4 address needs ALL five leading groups zero, not just one', () => {
  assert.strictEqual(isPublicAddress('fe80::1:ffff:808:808'), false, 'link-local that looks mapped');
  assert.strictEqual(isPublicAddress('fc00::1:ffff:808:808'), false, 'unique-local that looks mapped');
  assert.strictEqual(isPublicAddress('1:0:0:0:0:ffff:808:808'), false, 'a non-zero first group');
  assert.strictEqual(isPublicAddress('0:0:0:0:1:ffff:808:808'), false, 'a non-zero fifth group');
  assert.strictEqual(isPublicAddress('::ffff:8.8.8.8'), true);
  assert.strictEqual(isPublicAddress('::ffff:127.0.0.1'), false);
  assert.strictEqual(isPublicAddress('::ffff:10.1.2.3'), false);
});
