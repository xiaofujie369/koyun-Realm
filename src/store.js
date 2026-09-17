import { DatabaseSync } from 'node:sqlite';
import { randomToken, sha256, nowISO, validateRule } from './shared.js';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE,
        token_hint TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        desired_version INTEGER NOT NULL DEFAULT 1,
        applied_version INTEGER NOT NULL DEFAULT 0,
        agent_version TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'never_seen',
        last_error TEXT NOT NULL DEFAULT '',
        last_seen TEXT,
        remote_ip TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        listen_host TEXT NOT NULL DEFAULT '0.0.0.0',
        listen_port INTEGER NOT NULL,
        remote_host TEXT NOT NULL,
        remote_port INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(node_id, listen_host, listen_port)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        agent_token TEXT,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_enrollments_node ON enrollments(node_id);
    `);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  dashboard() {
    const nodes = this.db.prepare('SELECT COUNT(*) total, SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END) online FROM nodes').get(new Date(Date.now() - 45_000).toISOString());
    const rules = this.db.prepare('SELECT COUNT(*) total, SUM(enabled) enabled FROM rules').get();
    return {
      nodes: Number(nodes.total || 0),
      onlineNodes: Number(nodes.online || 0),
      rules: Number(rules.total || 0),
      enabledRules: Number(rules.enabled || 0)
    };
  }

  listNodes() {
    const threshold = new Date(Date.now() - 45_000).toISOString();
    return this.db.prepare(`
      SELECT n.id, n.name, n.token_hint tokenHint, n.enabled,
        n.desired_version desiredVersion, n.applied_version appliedVersion,
        n.agent_version agentVersion, n.status, n.last_error lastError,
        n.last_seen lastSeen, n.remote_ip remoteIp, n.created_at createdAt,
        COUNT(r.id) ruleCount,
        CASE WHEN n.last_seen >= ? THEN 1 ELSE 0 END online
      FROM nodes n LEFT JOIN rules r ON r.node_id=n.id
      GROUP BY n.id ORDER BY n.id DESC
    `).all(threshold);
  }

  createNode(name) {
    const clean = String(name ?? '').trim();
    if (!clean || clean.length > 80) throw new Error('节点名称长度必须为 1-80');
    const pendingTokenHash = sha256(`pending:${randomToken(32)}`);
    const time = nowISO();
    const result = this.db.prepare(`INSERT INTO nodes
      (name, token_hash, token_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(clean, pendingTokenHash, '待安装', time, time);
    this.event(Number(result.lastInsertRowid), 'info', '节点已创建');
    return { id: Number(result.lastInsertRowid), name: clean, enrollment: this.createEnrollment(Number(result.lastInsertRowid)) };
  }

  createEnrollment(nodeId, ttlMinutes = 30) {
    const node = this.db.prepare('SELECT id, name FROM nodes WHERE id=?').get(Number(nodeId));
    if (!node) throw new Error('节点不存在');
    const token = `kye_${randomToken(24)}`;
    const createdAt = nowISO();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    this.transaction(() => {
      this.db.prepare('DELETE FROM enrollments WHERE node_id=? OR expires_at<=?').run(Number(nodeId), createdAt);
      this.db.prepare(`INSERT INTO enrollments
        (node_id,token_hash,expires_at,created_at) VALUES (?,?,?,?)`)
        .run(Number(nodeId), sha256(token), expiresAt, createdAt);
      this.event(Number(nodeId), 'info', '已生成一键安装命令');
    });
    return { token, expiresAt };
  }

  redeemEnrollment(token) {
    if (!String(token || '').startsWith('kye_')) return null;
    return this.transaction(() => {
      const time = nowISO();
      this.db.prepare('DELETE FROM enrollments WHERE expires_at<=?').run(time);
      const enrollment = this.db.prepare(`SELECT e.id, e.node_id nodeId, e.agent_token agentToken,
        e.expires_at expiresAt, n.name nodeName
        FROM enrollments e JOIN nodes n ON n.id=e.node_id
        WHERE e.token_hash=? AND e.expires_at>?`).get(sha256(token), time);
      if (!enrollment) return null;
      if (!enrollment.agentToken) {
        enrollment.agentToken = `kya_${randomToken(32)}`;
        this.db.prepare('UPDATE enrollments SET agent_token=?, redeemed_at=? WHERE id=?')
          .run(enrollment.agentToken, time, enrollment.id);
        this.db.prepare(`UPDATE nodes SET token_hash=?, token_hint=?, status='starting',
          last_error='', last_seen=NULL, updated_at=? WHERE id=?`)
          .run(sha256(enrollment.agentToken), enrollment.agentToken.slice(-8), time, enrollment.nodeId);
        this.event(enrollment.nodeId, 'info', '一键安装命令已领取 Agent 凭据');
      }
      return enrollment;
    });
  }

  deleteNode(id) {
    const result = this.db.prepare('DELETE FROM nodes WHERE id=?').run(Number(id));
    if (!result.changes) throw new Error('节点不存在');
  }

  listRules() {
    return this.db.prepare(`SELECT r.id, r.node_id nodeId, n.name nodeName, r.name,
      r.listen_host listenHost, r.listen_port listenPort, r.remote_host remoteHost,
      r.remote_port remotePort, r.enabled, r.created_at createdAt
      FROM rules r JOIN nodes n ON n.id=r.node_id ORDER BY r.id DESC`).all();
  }

  createRule(input) {
    const rule = validateRule(input);
    if (!Number.isInteger(rule.nodeId) || !this.db.prepare('SELECT 1 FROM nodes WHERE id=?').get(rule.nodeId)) {
      throw new Error('入口节点不存在');
    }
    const time = nowISO();
    return this.transaction(() => {
      const result = this.db.prepare(`INSERT INTO rules
        (node_id,name,listen_host,listen_port,remote_host,remote_port,enabled,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(rule.nodeId, rule.name, rule.listenHost, rule.listenPort,
          rule.remoteHost, rule.remotePort, rule.enabled, time, time);
      this.bumpVersion(rule.nodeId);
      this.event(rule.nodeId, 'info', `新增规则：${rule.name}`);
      return { id: Number(result.lastInsertRowid), ...rule };
    });
  }

  setRuleEnabled(id, enabled) {
    const existing = this.db.prepare('SELECT node_id nodeId, name FROM rules WHERE id=?').get(Number(id));
    if (!existing) throw new Error('规则不存在');
    this.transaction(() => {
      this.db.prepare('UPDATE rules SET enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, nowISO(), Number(id));
      this.bumpVersion(existing.nodeId);
      this.event(existing.nodeId, 'info', `${enabled ? '启用' : '停用'}规则：${existing.name}`);
    });
  }

  deleteRule(id) {
    const existing = this.db.prepare('SELECT node_id nodeId, name FROM rules WHERE id=?').get(Number(id));
    if (!existing) throw new Error('规则不存在');
    this.transaction(() => {
      this.db.prepare('DELETE FROM rules WHERE id=?').run(Number(id));
      this.bumpVersion(existing.nodeId);
      this.event(existing.nodeId, 'info', `删除规则：${existing.name}`);
    });
  }

  bumpVersion(nodeId) {
    this.db.prepare('UPDATE nodes SET desired_version=desired_version+1, updated_at=? WHERE id=?').run(nowISO(), Number(nodeId));
  }

  authenticateAgent(token) {
    if (!token) return null;
    return this.db.prepare('SELECT id, name, desired_version desiredVersion, enabled FROM nodes WHERE token_hash=?').get(sha256(token));
  }

  desiredConfig(nodeId) {
    const node = this.db.prepare('SELECT id, name, desired_version desiredVersion, enabled FROM nodes WHERE id=?').get(Number(nodeId));
    if (!node || !node.enabled) throw new Error('节点已禁用或不存在');
    const rules = this.db.prepare(`SELECT id, name, listen_host listenHost, listen_port listenPort,
      remote_host remoteHost, remote_port remotePort, enabled
      FROM rules WHERE node_id=? AND enabled=1 ORDER BY id`).all(Number(nodeId));
    return { nodeId: node.id, nodeName: node.name, version: node.desiredVersion, rules };
  }

  heartbeat(nodeId, input, remoteIp) {
    const status = ['starting', 'healthy', 'degraded', 'error', 'stopped'].includes(input.status) ? input.status : 'error';
    const error = String(input.error ?? '').slice(0, 500);
    this.db.prepare(`UPDATE nodes SET applied_version=?, agent_version=?, status=?, last_error=?,
      last_seen=?, remote_ip=?, updated_at=? WHERE id=?`).run(
      Number(input.appliedVersion || 0), String(input.agentVersion || '').slice(0, 32), status,
      error, nowISO(), String(remoteIp || '').slice(0, 80), nowISO(), Number(nodeId));
    // The installer no longer needs to reveal the temporary plaintext token
    // after the agent has authenticated successfully.
    this.db.prepare('DELETE FROM enrollments WHERE node_id=?').run(Number(nodeId));
  }

  event(nodeId, level, message) {
    this.db.prepare('INSERT INTO events (node_id,level,message,created_at) VALUES (?,?,?,?)')
      .run(nodeId || null, level, String(message).slice(0, 500), nowISO());
    this.db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)').run();
  }

  listEvents(limit = 30) {
    return this.db.prepare(`SELECT e.id, e.level, e.message, e.created_at createdAt,
      n.name nodeName FROM events e LEFT JOIN nodes n ON n.id=e.node_id
      ORDER BY e.id DESC LIMIT ?`).all(Math.min(Math.max(Number(limit) || 30, 1), 100));
  }

  close() {
    this.db.close();
  }
}
