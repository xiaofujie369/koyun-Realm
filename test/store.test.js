import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

test('node token, rule versioning and agent authentication form a closed loop', () => {
  const store = new Store(':memory:');
  const node = store.createNode('上海入口 01');
  assert.ok(node.token.startsWith('kya_'));
  const auth = store.authenticateAgent(node.token);
  assert.equal(auth.name, '上海入口 01');
  const rule = store.createRule({ name: '东京 443', nodeId: node.id, listenHost: '0.0.0.0', listenPort: 18443, remoteHost: '203.0.113.10', remotePort: 443 });
  assert.equal(rule.listenPort, 18443);
  const desired = store.desiredConfig(node.id);
  assert.equal(desired.version, 2);
  assert.equal(desired.rules.length, 1);
  store.heartbeat(node.id, { status: 'healthy', appliedVersion: 2, agentVersion: '0.1.0' }, '198.51.100.2');
  const listed = store.listNodes()[0];
  assert.equal(listed.appliedVersion, 2);
  assert.equal(listed.online, 1);
  assert.throws(() => store.createRule({ name: '冲突', nodeId: node.id, listenHost: '0.0.0.0', listenPort: 18443, remoteHost: 'x.test', remotePort: 80 }), /UNIQUE/);
  store.close();
});
