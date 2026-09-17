const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let nodes = [];
let rules = [];

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/login') showLogin();
  if (!response.ok) throw new Error(body.error || `请求失败：${response.status}`);
  return body;
}

function esc(value) { const el = document.createElement('span'); el.textContent = value ?? ''; return el.innerHTML; }
function toast(message, bad = false) { const el = $('#toast'); el.textContent = message; el.className = `toast show${bad ? ' bad' : ''}`; setTimeout(() => el.className = 'toast', 2600); }
function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }
function formatTime(value) { if (!value) return '从未'; return new Date(value).toLocaleString('zh-CN', { hour12: false }); }

async function refresh() {
  try {
    const [overview, nodeData, ruleData] = await Promise.all([api('/api/overview'), api('/api/nodes'), api('/api/rules')]);
    nodes = nodeData; rules = ruleData;
    $('#stat-nodes').textContent = overview.nodes;
    $('#stat-online').textContent = `${overview.onlineNodes} 在线`;
    $('#stat-rules').textContent = overview.rules;
    $('#stat-enabled').textContent = `${overview.enabledRules} 已启用`;
    const synced = nodes.filter((n) => n.online && n.appliedVersion === n.desiredVersion).length;
    $('#stat-sync').textContent = `${synced}/${overview.onlineNodes}`;
    renderEvents(overview.events); renderNodes(); renderRules(); fillNodeSelect();
    showApp();
  } catch (error) { if (!$('#app').classList.contains('hidden')) toast(error.message, true); }
}

function renderEvents(events) {
  const el = $('#events');
  if (!events.length) { el.className = 'events empty'; el.textContent = '暂无事件'; return; }
  el.className = 'events';
  el.innerHTML = events.map((e) => `<div class="event"><time>${esc(formatTime(e.createdAt))}</time><span>${esc(e.message)}</span><small>${esc(e.nodeName || '系统')}</small></div>`).join('');
}

function renderNodes() {
  $('#nodes-body').innerHTML = nodes.length ? nodes.map((n) => {
    const synced = n.appliedVersion === n.desiredVersion;
    const state = n.online ? (n.status === 'healthy' ? '在线' : n.status) : '离线';
    const stateClass = n.online ? (n.status === 'healthy' ? 'online' : 'error') : '';
    return `<tr><td><span class="node-name"><b>${esc(n.name)}</b><small>Token ···${esc(n.tokenHint)} · Agent ${esc(n.agentVersion || '—')}</small></span></td><td><span class="badge ${stateClass}">${esc(state)}</span><small class="subline">${esc(formatTime(n.lastSeen))}</small></td><td><span class="badge ${synced ? 'on' : ''}">${n.appliedVersion} / ${n.desiredVersion}</span></td><td>${n.ruleCount}</td><td>${esc(n.remoteIp || '—')}</td><td><div class="actions"><button class="mini danger" data-delete-node="${n.id}">删除</button></div></td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-row">还没有节点，请先创建入口节点</td></tr>';
}

function renderRules() {
  $('#rules-body').innerHTML = rules.length ? rules.map((r) => `<tr><td><span class="rule-name"><b>${esc(r.name)}</b><small>#${r.id}</small></span></td><td>${esc(r.nodeName)}</td><td>${esc(r.listenHost)}:${r.listenPort}</td><td>${esc(r.remoteHost)}:${r.remotePort}</td><td><span class="badge ${r.enabled ? 'on' : ''}">${r.enabled ? '已启用' : '已停用'}</span></td><td><div class="actions"><button class="mini" data-toggle-rule="${r.id}" data-enabled="${r.enabled ? 0 : 1}">${r.enabled ? '停用' : '启用'}</button><button class="mini danger" data-delete-rule="${r.id}">删除</button></div></td></tr>`).join('') : '<tr><td colspan="6" class="empty-row">还没有转发规则</td></tr>';
}

function fillNodeSelect() { $('#rule-node').innerHTML = nodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join(''); }

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#login-error').textContent = '';
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try { await api('/api/login', { method: 'POST', body: JSON.stringify(data) }); await refresh(); }
  catch (error) { $('#login-error').textContent = error.message; }
});

$$('.nav').forEach((button) => button.addEventListener('click', () => {
  $$('.nav').forEach((item) => item.classList.toggle('active', item === button));
  $$('.view').forEach((view) => view.classList.add('hidden'));
  $(`#view-${button.dataset.view}`).classList.remove('hidden');
  $('#page-title').textContent = button.textContent.trim();
}));

$('#add-node').addEventListener('click', () => $('#node-dialog').showModal());
$('#add-rule').addEventListener('click', () => nodes.length ? $('#rule-dialog').showModal() : toast('请先创建入口节点', true));
$$('.close').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));

$('#node-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/nodes', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    event.currentTarget.reset(); $('#node-dialog').close();
    $('#created-controller').value = result.controllerUrl; $('#created-token').value = result.token;
    $('#agent-env').textContent = `CONTROLLER_URL=${result.controllerUrl}\nAGENT_TOKEN=${result.token}\nENGINE=realm`;
    $('#token-dialog').showModal(); await refresh();
  } catch (error) { toast(error.message, true); }
});

$('#rule-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
  data.nodeId = Number(data.nodeId); data.listenPort = Number(data.listenPort); data.remotePort = Number(data.remotePort);
  try { await api('/api/rules', { method: 'POST', body: JSON.stringify(data) }); event.currentTarget.reset(); event.currentTarget.listenHost.value = '0.0.0.0'; $('#rule-dialog').close(); toast('规则已创建，等待 Agent 下发'); await refresh(); }
  catch (error) { toast(error.message, true); }
});

document.addEventListener('click', async (event) => {
  const t = event.target;
  try {
    if (t.dataset.toggleRule) { await api(`/api/rules/${t.dataset.toggleRule}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled: t.dataset.enabled === '1' }) }); await refresh(); }
    if (t.dataset.deleteRule && confirm('删除此规则？Agent 下次同步时将停止监听。')) { await api(`/api/rules/${t.dataset.deleteRule}`, { method: 'DELETE' }); await refresh(); }
    if (t.dataset.deleteNode && confirm('删除节点会同时删除它的全部规则，确定继续？')) { await api(`/api/nodes/${t.dataset.deleteNode}`, { method: 'DELETE' }); await refresh(); }
  } catch (error) { toast(error.message, true); }
});

$('#copy-token').addEventListener('click', async () => { await navigator.clipboard.writeText($('#created-token').value); toast('Token 已复制'); });
$('#refresh').addEventListener('click', refresh);
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); showLogin(); });
refresh(); setInterval(() => { if (!$('#app').classList.contains('hidden')) refresh(); }, 15_000);
