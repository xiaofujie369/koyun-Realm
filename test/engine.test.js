import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { BuiltinEngine, RealmEngine } from '../src/engine.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('builtin test engine forwards TCP bytes end-to-end', async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(echo);
  const placeholder = net.createServer();
  const listenPort = await listen(placeholder);
  await new Promise((resolve) => placeholder.close(resolve));

  const engine = new BuiltinEngine();
  await engine.apply([{ listenHost: '127.0.0.1', listenPort, remoteHost: '127.0.0.1', remotePort: targetPort }]);
  const client = net.createConnection({ host: '127.0.0.1', port: listenPort });
  await once(client, 'connect');
  client.write('koyun-relay-v1');
  const [data] = await once(client, 'data');
  assert.equal(data.toString(), 'koyun-relay-v1');
  client.end();
  await once(client, 'close');
  await engine.stop();
  await new Promise((resolve) => echo.close(resolve));
});

test('builtin engine rolls back when a new listener cannot bind', async () => {
  const target = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(target);
  const p1 = net.createServer(); const goodPort = await listen(p1); await new Promise((r) => p1.close(r));
  const blocker = net.createServer(); const blockedPort = await listen(blocker);
  const engine = new BuiltinEngine();
  await engine.apply([{ listenHost: '127.0.0.1', listenPort: goodPort, remoteHost: '127.0.0.1', remotePort: targetPort }]);
  await assert.rejects(engine.apply([{ listenHost: '127.0.0.1', listenPort: blockedPort, remoteHost: '127.0.0.1', remotePort: targetPort }]));
  const client = net.createConnection({ host: '127.0.0.1', port: goodPort });
  await once(client, 'connect'); client.end(); await once(client, 'close');
  await engine.stop();
  await new Promise((r) => blocker.close(r)); await new Promise((r) => target.close(r));
});

test('Realm engine restores the previous rules when candidate process exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koyun-realm-'));
  const fakeRealm = path.join(dir, 'fake-realm.cjs');
  fs.writeFileSync(fakeRealm, `#!/usr/bin/env node
const fs = require('node:fs');
const content = fs.readFileSync(process.argv[process.argv.indexOf('-c') + 1], 'utf8');
if (content.includes(':19999')) { console.error('simulated bind failure'); process.exit(2); }
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`, { mode: 0o755 });
  const engine = new RealmEngine({ realmBin: fakeRealm, stateDir: dir, observeMs: 100 });
  const good = [{ listenHost: '127.0.0.1', listenPort: 18888, remoteHost: '127.0.0.1', remotePort: 80 }];
  await engine.apply(good);
  await assert.rejects(engine.apply([{ listenHost: '127.0.0.1', listenPort: 19999, remoteHost: '127.0.0.1', remotePort: 80 }]), /已回滚/);
  assert.equal(engine.status().running, true);
  assert.equal(engine.activeRules[0].listenPort, 18888);
  await engine.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
