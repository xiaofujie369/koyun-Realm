import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_VERSION, hashConfig, parseBoolean } from './shared.js';
import { BuiltinEngine, RealmEngine } from './engine.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

export class Agent {
  constructor(options = {}) {
    this.controller = String(options.controller || required('CONTROLLER_URL')).replace(/\/$/, '');
    this.token = options.token || required('AGENT_TOKEN');
    this.pollMs = Number(options.pollMs || process.env.POLL_INTERVAL_MS || 10_000);
    this.stateDir = options.stateDir || process.env.STATE_DIR || '/var/lib/koyun-agent';
    this.allowHttp = options.allowHttp ?? parseBoolean(process.env.ALLOW_INSECURE_HTTP, false);
    const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(this.controller);
    if (!this.controller.startsWith('https://') && !this.allowHttp && !local) {
      throw new Error('远程控制端必须使用 HTTPS；仅测试环境可设置 ALLOW_INSECURE_HTTP=true');
    }
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o750 });
    const engineName = options.engineName || process.env.ENGINE || 'realm';
    this.engine = options.engine || (engineName === 'builtin'
      ? new BuiltinEngine()
      : new RealmEngine({ realmBin: process.env.REALM_BIN || '/usr/local/bin/realm', stateDir: this.stateDir }));
    this.appliedVersion = 0;
    this.appliedHash = '';
    this.lastRules = [];
    this.status = 'starting';
    this.lastError = '';
    this.running = true;
    this.loadState();
  }

  loadState() {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'agent-state.json'), 'utf8'));
      this.appliedVersion = Number(state.appliedVersion || 0);
      this.lastRules = Array.isArray(state.rules) ? state.rules : [];
      this.engine.activeRules = structuredClone(this.lastRules);
      // A restarted agent has no managed Realm child yet. Force one re-apply.
      this.appliedHash = '';
    } catch {}
  }

  saveState() {
    const target = path.join(this.stateDir, 'agent-state.json');
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ appliedVersion: this.appliedVersion, appliedHash: this.appliedHash, rules: this.lastRules }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, target);
  }

  async request(route, options = {}) {
    const response = await fetch(`${this.controller}${route}`, {
      ...options,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(options.headers || {}) },
      signal: AbortSignal.timeout(8_000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `控制端响应 ${response.status}`);
    return body;
  }

  async heartbeat() {
    const engine = this.engine.status();
    await this.request('/api/agent/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ agentVersion: AGENT_VERSION, appliedVersion: this.appliedVersion, status: this.status, error: this.lastError || engine.error || '' })
    });
  }

  async syncOnce() {
    const config = await this.request('/api/agent/config');
    const configHash = hashConfig(config.rules);
    if (config.version !== this.appliedVersion || configHash !== this.appliedHash) {
      console.log(`[agent] applying version ${config.version}, ${config.rules.length} rule(s)`);
      await this.engine.apply(config.rules);
      this.appliedVersion = Number(config.version);
      this.appliedHash = configHash;
      this.lastRules = structuredClone(config.rules);
      this.saveState();
      console.log(`[agent] version ${config.version} applied`);
    }
    const engine = this.engine.status();
    this.status = engine.running ? 'healthy' : 'error';
    this.lastError = engine.running ? '' : (engine.error || '转发进程未运行');
    await this.heartbeat();
  }

  async run() {
    console.log(`[agent] ${AGENT_VERSION} started; engine=${this.engine.constructor.name}`);
    while (this.running) {
      try {
        await this.syncOnce();
      } catch (error) {
        this.status = this.appliedVersion ? 'degraded' : 'error';
        this.lastError = String(error.message || error).slice(0, 500);
        console.error('[agent]', this.lastError);
        try { await this.heartbeat(); } catch {}
      }
      await sleep(this.pollMs);
    }
  }

  async stop() {
    this.running = false;
    this.status = 'stopped';
    try { await this.heartbeat(); } catch {}
    await this.engine.stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const agent = new Agent();
    const shutdown = async () => { await agent.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await agent.run();
  } catch (error) {
    console.error(`[agent] startup failed: ${error.message}`);
    process.exit(1);
  }
}
