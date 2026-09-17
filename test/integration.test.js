import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
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
  store.createRule({ name: '测试转发', nodeId: node.id, listenHost: '127.0.0.1', listenPort: relayPort, remoteHost: '127.0.0.1', remotePort: targetPort });
  const engine = new BuiltinEngine();
  const agent = new Agent({ controller: `http://127.0.0.1:${controllerPort}`, token: node.token, stateDir: temp, engine, pollMs: 50 });
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
