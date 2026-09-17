import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { renderRealmConfig } from './shared.js';

const wait = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

export class BuiltinEngine {
  constructor() {
    this.servers = [];
    this.activeRules = [];
  }

  async apply(rules) {
    const oldRules = this.activeRules;
    await this.stop();
    try {
      await this.start(rules);
      this.activeRules = structuredClone(rules);
    } catch (error) {
      await this.stop();
      if (oldRules.length) await this.start(oldRules);
      this.activeRules = oldRules;
      throw error;
    }
  }

  async start(rules) {
    for (const rule of rules) {
      const server = net.createServer((client) => {
        client.setNoDelay(true);
        const upstream = net.createConnection({ host: rule.remoteHost, port: rule.remotePort });
        upstream.setNoDelay(true);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
        client.pipe(upstream).pipe(client);
      });
      server.on('error', () => {});
      server.listen(rule.listenPort, rule.listenHost);
      try { await once(server, 'listening'); }
      catch (error) { server.close(); throw error; }
      this.servers.push(server);
    }
  }

  async stop() {
    const servers = this.servers.splice(0);
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }

  status() { return { running: this.servers.length > 0 || this.activeRules.length === 0, detail: `builtin:${this.servers.length}` }; }
}

export class RealmEngine {
  constructor({ realmBin, stateDir, observeMs = 1500 }) {
    this.realmBin = realmBin;
    this.stateDir = stateDir;
    this.observeMs = observeMs;
    this.child = null;
    this.activeRules = [];
    this.lastError = '';
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o750 });
  }

  async apply(rules) {
    const oldRules = this.activeRules;
    const candidate = path.join(this.stateDir, 'realm.candidate.toml');
    fs.writeFileSync(candidate, renderRealmConfig(rules), { mode: 0o640 });
    await this.stop();
    if (!rules.length) {
      this.activeRules = [];
      fs.renameSync(candidate, path.join(this.stateDir, 'realm.toml'));
      return;
    }
    try {
      await this.start(candidate);
      fs.renameSync(candidate, path.join(this.stateDir, 'realm.toml'));
      this.activeRules = structuredClone(rules);
    } catch (error) {
      this.lastError = error.message;
      await this.stop();
      if (oldRules.length) {
        const rollback = path.join(this.stateDir, 'realm.rollback.toml');
        fs.writeFileSync(rollback, renderRealmConfig(oldRules), { mode: 0o640 });
        await this.start(rollback);
        fs.renameSync(rollback, path.join(this.stateDir, 'realm.toml'));
      }
      this.activeRules = oldRules;
      throw new Error(`Realm 新配置启动失败，已回滚：${error.message}`);
    }
  }

  async start(configPath) {
    const child = spawn(this.realmBin, ['-c', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    let stderr = '';
    let startupError = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    let exited = false;
    child.once('exit', (code, signal) => {
      exited = true;
      if (this.child === child) this.child = null;
      if (code !== 0) this.lastError = stderr.trim() || `Realm 退出：code=${code}, signal=${signal || '-'}`;
    });
    child.once('error', (error) => { startupError = error.message; this.lastError = error.message; if (this.child === child) this.child = null; });
    await wait(this.observeMs);
    if (startupError || exited || !this.child) throw new Error(startupError || stderr.trim() || 'Realm 进程提前退出');
    this.lastError = '';
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    const exited = once(child, 'exit').catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([exited, wait(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  status() {
    return { running: this.activeRules.length === 0 || Boolean(this.child), detail: `realm:${this.activeRules.length}`, error: this.lastError };
  }
}
