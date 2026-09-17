import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { parseBoolean, randomToken, safeEqual } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('JSON 格式无效'); }
}

function cookieMap(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2));
}

function makeSession(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 60 * 60 * 1000, nonce: randomToken(12) })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(value, secret) {
  if (!value || !value.includes('.')) return false;
  const [payload, signature] = value.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url')).exp > Date.now(); }
  catch { return false; }
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '';
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

export function createController(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.resolve('data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o750 });
  const store = options.store || new Store(path.join(dataDir, 'koyun.db'));
  const adminUser = options.adminUser || process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = options.adminPassword || process.env.ADMIN_PASSWORD || '';
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET || randomToken(48);
  const secureCookie = options.secureCookie ?? !parseBoolean(process.env.COOKIE_INSECURE, false);
  const publicUrl = String(options.publicUrl || process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const loginAttempts = new Map();

  if (process.env.NODE_ENV === 'production') {
    if (adminPassword.length < 12) throw new Error('生产环境 ADMIN_PASSWORD 至少需要 12 个字符');
    if (sessionSecret.length < 32) throw new Error('生产环境 SESSION_SECRET 至少需要 32 个字符');
  }

  if (!adminPassword) {
    console.warn('[WARN] ADMIN_PASSWORD 未设置，控制端仅允许从本机登录。');
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method || 'GET';
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (url.pathname === '/healthz') return json(res, 200, { ok: true });

      if (url.pathname === '/api/login' && method === 'POST') {
        const ip = clientIp(req);
        const attempt = loginAttempts.get(ip);
        if (attempt?.blockedUntil > Date.now()) return json(res, 429, { error: '登录尝试过多，请稍后再试' });
        const body = await readJson(req);
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        if (!adminPassword && !local) return json(res, 503, { error: '控制端尚未设置管理员密码' });
        if (!safeEqual(body.username || '', adminUser) || (adminPassword && !safeEqual(body.password || '', adminPassword))) {
          const failures = (attempt?.failures || 0) + 1;
          loginAttempts.set(ip, { failures, blockedUntil: failures >= 5 ? Date.now() + 5 * 60_000 : 0 });
          await new Promise((resolve) => setTimeout(resolve, 350));
          return json(res, 401, { error: '用户名或密码错误' });
        }
        loginAttempts.delete(ip);
        const cookie = `koyun_session=${encodeURIComponent(makeSession(sessionSecret))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secureCookie ? '; Secure' : ''}`;
        return json(res, 200, { ok: true }, { 'set-cookie': cookie });
      }

      if (url.pathname === '/api/logout' && method === 'POST') {
        return json(res, 200, { ok: true }, { 'set-cookie': 'koyun_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
      }

      if (url.pathname.startsWith('/api/agent/')) {
        const node = store.authenticateAgent(bearer(req));
        if (!node || !node.enabled) return json(res, 401, { error: 'Agent Token 无效或节点已禁用' });
        if (url.pathname === '/api/agent/config' && method === 'GET') {
          return json(res, 200, store.desiredConfig(node.id), { 'cache-control': 'no-store' });
        }
        if (url.pathname === '/api/agent/heartbeat' && method === 'POST') {
          store.heartbeat(node.id, await readJson(req), clientIp(req));
          return json(res, 200, { ok: true, desiredVersion: node.desiredVersion });
        }
        return json(res, 404, { error: '接口不存在' });
      }

      if (url.pathname.startsWith('/api/')) {
        if (!verifySession(cookieMap(req).koyun_session, sessionSecret)) return json(res, 401, { error: '请先登录' });
        if (!['GET', 'HEAD'].includes(method) && !requireSameOrigin(req)) return json(res, 403, { error: '来源校验失败' });

        if (url.pathname === '/api/overview' && method === 'GET') return json(res, 200, { ...store.dashboard(), events: store.listEvents() });
        if (url.pathname === '/api/nodes' && method === 'GET') return json(res, 200, store.listNodes());
        if (url.pathname === '/api/nodes' && method === 'POST') {
          const node = store.createNode((await readJson(req)).name);
          const base = publicUrl || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
          return json(res, 201, { ...node, controllerUrl: base });
        }
        const nodeDelete = url.pathname.match(/^\/api\/nodes\/(\d+)$/);
        if (nodeDelete && method === 'DELETE') { store.deleteNode(nodeDelete[1]); return json(res, 200, { ok: true }); }

        if (url.pathname === '/api/rules' && method === 'GET') return json(res, 200, store.listRules());
        if (url.pathname === '/api/rules' && method === 'POST') return json(res, 201, store.createRule(await readJson(req)));
        const ruleToggle = url.pathname.match(/^\/api\/rules\/(\d+)\/enabled$/);
        if (ruleToggle && method === 'PATCH') { store.setRuleEnabled(ruleToggle[1], Boolean((await readJson(req)).enabled)); return json(res, 200, { ok: true }); }
        const ruleDelete = url.pathname.match(/^\/api\/rules\/(\d+)$/);
        if (ruleDelete && method === 'DELETE') { store.deleteRule(ruleDelete[1]); return json(res, 200, { ok: true }); }
        return json(res, 404, { error: '接口不存在' });
      }

      const staticFiles = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/extras.css': 'extras.css' };
      const file = staticFiles[url.pathname];
      if (!file) return json(res, 404, { error: '页面不存在' });
      const content = fs.readFileSync(path.join(publicDir, file));
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      res.writeHead(200, { 'content-type': type, 'content-length': content.length, 'cache-control': file === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
      res.end(content);
    } catch (error) {
      const conflict = String(error.message).includes('UNIQUE constraint');
      console.error('[controller]', error.message);
      json(res, conflict ? 409 : 400, { error: conflict ? '名称或监听端口已存在' : error.message || '请求失败' });
    }
  };

  const server = http.createServer(handler);
  return { server, store };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.LISTEN_ADDR || '0.0.0.0';
  const port = Number(process.env.PORT || 18890);
  const { server, store } = createController();
  server.listen(port, host, () => console.log(`[controller] listening on http://${host}:${port}`));
  const shutdown = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
