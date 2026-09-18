import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { createController } from '../src/controller.js';
import { Agent } from '../src/agent.js';
import { BuiltinEngine } from '../src/engine.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('controller -> agent -> TCP target works as a complete V1 flow', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'koyun-integration-'));
  const store = new Store(':memory:');
  const { server } = createController({ store, dataDir: temp, adminPassword: 'test-only', sessionSecret: 'x'.repeat(48), secureCookie: false });
  const controllerPort = await listen(server);
  const echo = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(echo);
  const reserve = net.createServer(); const relayPort = await listen(reserve); await new Promise((r) => reserve.close(r));

  const node = store.createNode('集成测试入口');
  const enrollment = store.redeemEnrollment(node.enrollment.token);
  const installerResponse = await fetch(`http://127.0.0.1:${controllerPort}/install/${node.enrollment.token}`);
  assert.equal(installerResponse.status, 200);
  assert.match(installerResponse.headers.get('cache-control'), /no-store/);
  const installer = await installerResponse.text();
  assert.match(installer, new RegExp(enrollment.agentToken));
  assert.doesNotMatch(installer, /__AGENT_TOKEN__/);
  const installerPath = path.join(temp, 'installer.sh');
  fs.writeFileSync(installerPath, installer);
  assert.equal(spawnSync('sh', ['-n', installerPath]).status, 0);
  store.createRule({ name: '测试转发', nodeId: node.id, listenHost: '127.0.0.1', listenPort: relayPort, remoteHost: '127.0.0.1', remotePort: targetPort });
  const engine = new BuiltinEngine();
  const agent = new Agent({ controller: `http://127.0.0.1:${controllerPort}`, token: enrollment.agentToken, stateDir: temp, engine, pollMs: 50 });
  await agent.syncOnce();

  const client = net.createConnection({ host: '127.0.0.1', port: relayPort });
  await once(client, 'connect'); client.write('panel-to-agent');
  const [data] = await once(client, 'data');
  assert.equal(data.toString(), 'panel-to-agent');
  assert.equal(store.listNodes()[0].status, 'healthy');
  assert.equal(store.listNodes()[0].appliedVersion, 2);

  client.end(); await once(client, 'close');
  await agent.stop();
  await new Promise((r) => echo.close(r));
  await new Promise((r) => server.close(r));
  store.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('admin creates a node and receives only a short-lived one-click command', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'koyun-panel-'));
  const store = new Store(':memory:');
  const { server } = createController({ store, dataDir: temp, adminPassword: 'test-password', sessionSecret: 's'.repeat(48), secureCookie: false, publicUrl: 'https://relay.example.com' });
  const port = await listen(server);
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/nodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ name: '一键安装测试' })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.installCommand, /\/install\/kye_/);
  assert.match(created.installCommand, /curl/);
  assert.match(created.installCommand, /wget/);
  assert.match(created.installCommand, /connect-timeout 8/);
  assert.match(created.installCommand, /max-time 45/);
  assert.match(created.installCommand, /curl -4fL/);
  assert.match(created.installCommand, /mktemp/);
  assert.doesNotMatch(created.installCommand, /curl -fsSL/);
  assert.equal('token' in created, false);
  assert.equal('agentToken' in created, false);
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
