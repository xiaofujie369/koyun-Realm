import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRealmConfig, validateRule } from '../src/shared.js';

test('validates and normalizes a TCP rule', () => {
  assert.deepEqual(validateRule({ name: ' Tokyo ', nodeId: 2, listenHost: '', listenPort: '8443', remoteHost: '1.2.3.4', remotePort: 443 }), {
    name: 'Tokyo', nodeId: 2, listenHost: '0.0.0.0', listenPort: 8443,
    remoteHost: '1.2.3.4', remotePort: 443, enabled: 1
  });
  assert.throws(() => validateRule({ name: 'x', nodeId: 1, listenPort: 0, remoteHost: 'a', remotePort: 1 }), /端口/);
});

test('renders deterministic Realm TCP-only config', () => {
  const config = renderRealmConfig([{ listenHost: '0.0.0.0', listenPort: 8443, remoteHost: '2001:db8::1', remotePort: 443, enabled: true }]);
  assert.match(config, /use_udp = false/);
  assert.match(config, /listen = "0\.0\.0\.0:8443"/);
  assert.match(config, /remote = "\[2001:db8::1\]:443"/);
});
