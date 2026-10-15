'use strict';
// A minimal stdio MCP server standing in for claude-custom's canvas server: three tools, newline-delimited JSON-RPC.
const readline = require('readline');
const fs = require('fs');
const LOG = process.env.CANVAS_MCP_LOG;
const log = (m) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(m) + '\n'); };
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const tools = [
  { name: 'canvas_render', description: 'Replace the canvas panel with this HTML', inputSchema: { type: 'object', properties: { html: { type: 'string' } }, required: ['html'] } },
  { name: 'canvas_add_button', description: 'Add a button to the canvas', inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } },
  { name: 'canvas_list_artifacts', description: 'List artifacts on the shelf', inputSchema: { type: 'object', properties: {} } },
];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  log({ method: m.method, env: { session: process.env.CANVAS_SESSION || null } });
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'canvas', version: '0.0.1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
