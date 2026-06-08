// Frontend SPA — connects to the backend over SSE, renders sessions,
// chat, changes, structure, audit, and policy views.

const state = {
  sessions: [],
  policies: {},
  activeSessionId: null,
  detail: null, // full session detail for active session
  view: 'chat',
  cwd: '',
  selectedChangeIdx: 0,
  selectedTreePath: null,
  structureCache: null,
  auditFilter: '',
  structureSearch: '',
  structureTab: 'tree',
  graphCache: null,
  graphSelectedId: null,
  graphSim: null,
  codeMapCache: null,
  codeMapSelected: null,
  codeMapExpanded: new Set(),
  gitNexusAvailable: null,
  gitNexusStatus: null,
  gitNexusSubtab: 'callgraph',
  gitNexusCallGraph: null,
  gitNexusGraphSelectedId: null,
  gitNexusProcesses: null,
  gitNexusImpact: null,
  gitNexusImpactSymbol: '',
  gitNexusAnalyzing: false,
  gitNexusLog: [],
  gitNexusHierarchy: null,         // { root, crossEdges, topByName, nodeFnCount }
  gitNexusHierarchyRoot: [],       // drill-down path, e.g. ['src']
  gitNexusHierarchySelected: null, // selected path string for detail pane
  gitNexusHierarchyHover: null,    // hovered top-level module name (for x-mod edges)
  memory: null,           // { entries: [...] }
  memoryTab: 'habit',     // 'habit' | 'experience'
  memoryFilterScope: 'all', // 'all' | 'workdir'
  depositDraft: null,     // { habits, experiences, distillError, turnId }
  depositSelected: null,  // { habits: Set<idx>, experiences: Set<idx> }
  lastDepositTurnId: null, // most recently finished turn — used by toolbar button
  terminal: null, // { term, fit, attachedSessionId, resizeObserver }
  suggestRelevant: [],    // experiences relevant to current prompt input
  suggestExpanded: false, // 相关经验默认折叠，点击标题展开
  suggestDebounce: null,
  expandedHeads: new Set(), // chain heads whose history list is expanded
  pendingPromptDraft: null, // { sessionId, text } — applied once active session matches
  approvalRenderSig: null,  // signature of last-rendered approval pane (id:deciderState|...)
};

// ===== Utility =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}
function fmtDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function truncate(s, n = 200) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ===== Markdown rendering =====
const _markedRenderer = new marked.Renderer();
_markedRenderer.code = function (codeOrToken, lang) {
  let code, language;
  if (typeof codeOrToken === 'object' && codeOrToken !== null) {
    code = codeOrToken.text || '';
    language = codeOrToken.lang || '';
  } else {
    code = codeOrToken || '';
    language = lang || '';
  }
  const langLabel = language ? escapeHtml(language) : '';
  let highlighted;
  if (language && hljs.getLanguage(language)) {
    highlighted = hljs.highlight(code, { language }).value;
  } else {
    highlighted = hljs.highlightAuto(code).value;
  }
  return `<div class="code-block">
    <div class="code-block-head"><span class="code-lang">${langLabel}</span><button class="code-copy-btn" data-action="copy-code">复制</button></div>
    <pre><code class="hljs">${highlighted}</code></pre>
  </div>`;
};
_markedRenderer.image = function (hrefOrToken, title, text) {
  let href, alt, titleVal;
  if (typeof hrefOrToken === 'object' && hrefOrToken !== null) {
    href = hrefOrToken.href || '';
    alt = hrefOrToken.text || '';
    titleVal = hrefOrToken.title || '';
  } else {
    href = hrefOrToken || '';
    alt = text || '';
    titleVal = title || '';
  }
  const altAttr = escapeHtml(alt);
  const titleAttr = titleVal ? ` title="${escapeHtml(titleVal)}"` : '';
  return `<img src="${escapeHtml(href)}" alt="${altAttr}"${titleAttr} class="msg-img" data-action="lightbox" />`;
};

_markedRenderer.link = function (hrefOrToken, title, text) {
  let href, linkTitle, linkText;
  if (typeof hrefOrToken === 'object' && hrefOrToken !== null) {
    href = hrefOrToken.href || '';
    linkTitle = hrefOrToken.title || '';
    linkText = hrefOrToken.text || '';
  } else {
    href = hrefOrToken || '';
    linkTitle = title || '';
    linkText = text || '';
  }
  const titleAttr = linkTitle ? ` title="${escapeHtml(linkTitle)}"` : '';
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${linkText}</a>`;
};

marked.setOptions({
  renderer: _markedRenderer,
  gfm: true,
  breaks: true,
});

function renderMarkdown(raw) {
  if (!raw) return '';
  const html = marked.parse(raw);
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['details', 'summary'],
    ADD_ATTR: ['class', 'target', 'rel', 'data-action'],
    FORBID_ATTR: ['onerror', 'onload', 'onmouseover', 'onclick', 'onfocus', 'onblur'],
  });
}

// Event delegation for rendered markdown actions (copy-code, lightbox)
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-action="copy-code"]');
  if (copyBtn) {
    const pre = copyBtn.closest('.code-block').querySelector('pre code');
    if (!pre) return;
    navigator.clipboard.writeText(pre.textContent).then(() => {
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    });
    return;
  }
  const img = e.target.closest('[data-action="lightbox"]');
  if (img) {
    openLightbox(img.src);
    return;
  }
});

// ===== Slash commands (autocomplete) =====
const SLASH_COMMANDS = [
  { cmd: '/compact', desc: '压缩上下文 — 总结对话关键信息，释放上下文窗口' },
  { cmd: '/review', desc: '代码审查 — 对当前分支变更进行正确性、安全性、性能审查' },
  { cmd: '/commit', desc: '智能提交 — 分析变更并生成规范的 commit message' },
  { cmd: '/test', desc: '运行测试 — 执行测试套件，分析失败原因' },
  { cmd: '/explain', desc: '解释代码 — 解释指定文件或模块的实现逻辑', args: '<文件或模块>' },
  { cmd: '/fix', desc: '修复问题 — 定位根本原因并实施修复', args: '<问题描述>' },
  { cmd: '/refactor', desc: '重构代码 — 保持行为不变，改善结构与可读性', args: '<目标>' },
  { cmd: '/pr', desc: '创建 PR — 基于当前分支变更创建 Pull Request' },
  { cmd: '/status', desc: '项目状态 — Git 状态、最近 commit、运行中的服务' },
];

const slashState = { active: false, selectedIdx: 0, filtered: [] };

function updateSlashMenu() {
  const input = $('#promptInput');
  const menu = $('#slashMenu');
  const val = input.value;

  const firstLine = val.split('\n')[0];
  if (!firstLine.startsWith('/') || firstLine.includes(' ') || val.indexOf('\n') > 0) {
    hideSlashMenu();
    return;
  }

  const query = firstLine.toLowerCase();
  slashState.filtered = SLASH_COMMANDS.filter(
    (c) => c.cmd.startsWith(query) || c.desc.includes(query.slice(1)),
  );

  if (slashState.filtered.length === 0) {
    hideSlashMenu();
    return;
  }

  slashState.active = true;
  slashState.selectedIdx = Math.min(slashState.selectedIdx, slashState.filtered.length - 1);
  menu.classList.remove('hidden');
  menu.innerHTML = slashState.filtered
    .map((c, i) => `
      <div class="slash-menu-item ${i === slashState.selectedIdx ? 'active' : ''}" data-i="${i}">
        <span class="slash-cmd">${escapeHtml(c.cmd)}${c.args ? ' ' + escapeHtml(c.args) : ''}</span>
        <span class="slash-desc">${escapeHtml(c.desc)}</span>
      </div>`)
    .join('');

  $$('.slash-menu-item', menu).forEach((el) => {
    el.addEventListener('mouseenter', () => {
      slashState.selectedIdx = parseInt(el.dataset.i);
      renderSlashSelection();
    });
    el.addEventListener('click', () => applySlashCommand(parseInt(el.dataset.i)));
  });
}

function renderSlashSelection() {
  const menu = $('#slashMenu');
  $$('.slash-menu-item', menu).forEach((el, i) =>
    el.classList.toggle('active', i === slashState.selectedIdx),
  );
}

function applySlashCommand(idx) {
  const item = slashState.filtered[idx];
  if (!item) return;
  const input = $('#promptInput');
  input.value = item.cmd + (item.args ? ' ' : '');
  input.focus();
  hideSlashMenu();
  const len = input.value.length;
  input.setSelectionRange(len, len);
}

function hideSlashMenu() {
  slashState.active = false;
  slashState.selectedIdx = 0;
  $('#slashMenu').classList.add('hidden');
}

function handleSlashKeydown(e) {
  if (!slashState.active) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    slashState.selectedIdx = (slashState.selectedIdx + 1) % slashState.filtered.length;
    renderSlashSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    slashState.selectedIdx = (slashState.selectedIdx - 1 + slashState.filtered.length) % slashState.filtered.length;
    renderSlashSelection();
  } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
    e.preventDefault();
    applySlashCommand(slashState.selectedIdx);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideSlashMenu();
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ===== Initial bootstrap =====
async function init() {
  $('#newSessionBtn').addEventListener('click', openNewSessionDialog);
  $('#dlgCancel').addEventListener('click', () => $('#newSessionDialog').close());
  $('#newSessionForm').addEventListener('submit', submitNewSession);
  $('#promptForm').addEventListener('submit', submitPrompt);
  $('#promptInput').addEventListener('keydown', (e) => {
    if (slashState.active) {
      handleSlashKeydown(e);
      if (e.defaultPrevented) return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $('#promptForm').requestSubmit();
    }
  });
  $('#cancelBtn').addEventListener('click', cancelTurn);
  $('#newTaskBtn').addEventListener('click', startNextTask);
  $('#policySelect').addEventListener('change', changePolicy);
  $('#refreshStructureBtn').addEventListener('click', () => {
    if (state.structureTab === 'tree') loadStructure();
    else if (state.structureTab === 'modules') loadDesignGraph();
    else if (state.structureTab === 'codemap') loadCodeMap();
    else if (state.structureTab === 'gitnexus') reloadGitNexusSubview(true);
  });
  $('#structureSearch').addEventListener('input', (e) => {
    state.structureSearch = e.target.value.toLowerCase();
    if (state.structureTab === 'tree') renderStructureView();
    else if (state.structureTab === 'modules') renderModuleGraph();
    else if (state.structureTab === 'codemap') renderCodeMapView();
    else if (state.structureTab === 'gitnexus') renderGitNexusPane();
  });
  $$('#structureTabs .tab-btn').forEach((b) =>
    b.addEventListener('click', () => switchStructureTab(b.dataset.tab)),
  );
  $('#auditFilter').addEventListener('input', (e) => {
    state.auditFilter = e.target.value.toLowerCase();
    renderAuditView();
  });

  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $('#depositCancel').addEventListener('click', () => $('#depositDialog').close());
  $('#depositCommit').addEventListener('click', commitDepositSelection);
  $('#depositRedistill').addEventListener('click', () => {
    const turnId = state.depositDraft?.turnId || state.lastDepositTurnId;
    if (turnId) openDepositDialog(turnId, { keepOpen: true });
  });
  $('#depositToolbarBtn').addEventListener('click', () => {
    if (state.lastDepositTurnId) openDepositDialog(state.lastDepositTurnId);
  });

  $('#terminalRestartBtn').addEventListener('click', restartTerminal);
  $('#terminalFullscreenBtn').addEventListener('click', toggleTerminalFullscreen);

  // Image upload handlers
  $('#imageUploadBtn').addEventListener('click', () => $('#imageFileInput').click());
  $('#imageFileInput').addEventListener('change', (e) => {
    handleImageFiles(e.target.files);
    e.target.value = '';
  });
  const promptInput = $('#promptInput');
  promptInput.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) imageFiles.push(item.getAsFile());
    }
    if (imageFiles.length) handleImageFiles(imageFiles);
  });
  const promptForm = $('#promptForm');
  promptForm.addEventListener('dragover', (e) => { e.preventDefault(); promptForm.classList.add('drag-over'); });
  promptForm.addEventListener('dragleave', () => promptForm.classList.remove('drag-over'));
  promptForm.addEventListener('drop', (e) => {
    e.preventDefault();
    promptForm.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (files.length) handleImageFiles(files);
  });

  $('#promptInput').addEventListener('input', () => {
    updateSlashMenu();
    scheduleSuggestRelevant();
  });

  // Load metadata
  const cwdResp = await api('/api/cwd');
  state.cwd = cwdResp.cwd;
  $('#cwdLabel').textContent = state.cwd;

  const policiesResp = await api('/api/policies');
  state.policies = policiesResp.policies;
  populatePolicySelectors();

  await refreshSessions();
  connectEvents();
  renderPolicyView();
}

function populatePolicySelectors() {
  const opts = Object.values(state.policies)
    .map((p) => `<option value="${p.id}">${p.name}</option>`)
    .join('');
  $('#policySelect').innerHTML = opts;
  $('#dlgPolicy').innerHTML = opts;
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => ($('#connStatus').textContent = '已连接'));
  es.addEventListener('error', () => ($('#connStatus').textContent = '连接断开（重试中）'));
  es.addEventListener('hello', () => ($('#connStatus').textContent = '已连接'));
  es.addEventListener('session:created', () => refreshSessions());
  es.addEventListener('session:removed', () => refreshSessions());
  es.addEventListener('session:updated', (e) => {
    const data = JSON.parse(e.data);
    const idx = state.sessions.findIndex((s) => s.id === data.id);
    if (idx >= 0) state.sessions[idx] = data;
    else state.sessions.unshift(data);
    if (data.id === state.activeSessionId && state.detail) {
      state.detail.session = data;
      renderTopbar();
    }
    renderSessionList();
  });
  es.addEventListener('event', (e) => {
    const data = JSON.parse(e.data);
    if (data.sessionId !== state.activeSessionId) return;
    handleSessionEvent(data.event);
  });
  es.addEventListener('gitnexus:start', (e) => {
    const data = JSON.parse(e.data);
    if (data.sessionId !== state.activeSessionId) return;
    state.gitNexusAnalyzing = true;
    state.gitNexusLog = [];
    if (state.view === 'structure' && state.structureTab === 'gitnexus') renderGitNexusStatus();
  });
  es.addEventListener('gitnexus:progress', (e) => {
    const data = JSON.parse(e.data);
    if (data.sessionId !== state.activeSessionId) return;
    state.gitNexusLog.push(data);
    if (state.gitNexusLog.length > 400) state.gitNexusLog = state.gitNexusLog.slice(-400);
    if (state.view === 'structure' && state.structureTab === 'gitnexus') renderGitNexusLog();
  });
  es.addEventListener('memory:updated', () => {
    if (state.view === 'memory') loadMemory();
  });
  es.addEventListener('term:data', (e) => {
    const data = JSON.parse(e.data);
    if (data.sessionId !== state.activeSessionId) return;
    if (state.terminal?.term) state.terminal.term.write(data.data);
  });
  es.addEventListener('term:exit', (e) => {
    const data = JSON.parse(e.data);
    if (data.sessionId !== state.activeSessionId) return;
    if (state.terminal) state.terminal.attachedSessionId = null;
  });
  es.addEventListener('gitnexus:done', (e) => {
    const data = JSON.parse(e.data);
    if (data.sessionId !== state.activeSessionId) return;
    state.gitNexusAnalyzing = false;
    state.gitNexusLog.push({ stream: 'stdout', line: data.error ? '✗ ' + data.error : `✓ 完成 (exit ${data.code})` });
    state.gitNexusStatus = null;
    state.gitNexusCallGraph = null;
    state.gitNexusProcesses = null;
    state.gitNexusHierarchy = null;
    state.gitNexusHierarchyRoot = [];
    state.gitNexusHierarchySelected = null;
    state.gitNexusHierarchyHover = null;
    if (state.view === 'structure' && state.structureTab === 'gitnexus') {
      loadGitNexusStatus();
      renderGitNexusLog();
    }
  });
}

async function refreshSessions() {
  const resp = await api('/api/sessions');
  state.sessions = resp.sessions;
  renderSessionList();
  if (!state.activeSessionId && state.sessions.length > 0) {
    selectSession(state.sessions[0].id);
  }
}

async function deleteSession(id) {
  const target = state.sessions.find((s) => s.id === id);
  const label = target ? `${target.name}（${target.id}）` : id;
  if (!confirm(`确定删除会话 ${label} 吗？\n\n同一目录下的所有历史会话都会一并清除（运行进程终止、事件 / 终端 / 持久化记录都会删除，不可撤销）。`)) {
    return;
  }
  try {
    await api(`/api/sessions/${id}`, { method: 'DELETE' });
  } catch (e) {
    alert('删除失败：' + e.message);
    return;
  }
  if (state.activeSessionId === id) {
    state.activeSessionId = null;
    state.detail = null;
  }
  // SSE `session:removed` will refresh the list; do an immediate refresh too
  // in case the event hasn't arrived yet (avoids a flicker showing the deleted row).
  await refreshSessions();
  renderAll();
}

function renderSessionList() {
  const ul = $('#sessionList');
  if (state.sessions.length === 0) {
    ul.innerHTML = '<li class="muted" style="padding:6px 10px;font-size:12px">还没有会话</li>';
    return;
  }

  // A "head" is a session that no other session points to via parentSessionId.
  // History walks parentSessionId backwards from the head until null/missing.
  const sessionMap = new Map(state.sessions.map((s) => [s.id, s]));
  const isParentOf = new Set();
  for (const s of state.sessions) {
    if (s.parentSessionId && sessionMap.has(s.parentSessionId)) {
      isParentOf.add(s.parentSessionId);
    }
  }
  const heads = state.sessions
    .filter((s) => !isParentOf.has(s.id))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  function buildHistory(headId) {
    const out = [];
    let cur = sessionMap.get(headId);
    const seen = new Set([headId]);
    while (cur && cur.parentSessionId && !seen.has(cur.parentSessionId)) {
      const p = sessionMap.get(cur.parentSessionId);
      if (!p) break;
      out.push(p);
      seen.add(p.id);
      cur = p;
    }
    return out;
  }

  const blocks = [];
  for (const head of heads) {
    const history = buildHistory(head.id);
    const expanded = state.expandedHeads.has(head.id);
    blocks.push(renderSessionItem(head, {
      isHead: true,
      historyCount: history.length,
      expanded,
    }));
    if (history.length > 0) {
      const hidden = expanded ? '' : ' hidden';
      for (const h of history) {
        blocks.push(renderSessionItem(h, {
          isHead: false,
          headId: head.id,
          hidden,
        }));
      }
    }
  }
  ul.innerHTML = blocks.join('');

  $$('.session-item').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.si-toggle')) return;
      if (ev.target.closest('.si-delete')) return;
      selectSession(el.dataset.id);
    });
  });
  $$('.si-toggle').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const headId = btn.dataset.head;
      if (state.expandedHeads.has(headId)) state.expandedHeads.delete(headId);
      else state.expandedHeads.add(headId);
      renderSessionList();
    });
  });
  $$('.si-delete').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteSession(btn.dataset.del);
    });
  });
}

function renderSessionItem(s, opts) {
  const { isHead, historyCount = 0, expanded = false, headId, hidden = '' } = opts;
  const classes = ['session-item'];
  if (s.id === state.activeSessionId) classes.push('active');
  if (!isHead) classes.push('history');
  const status = renderStatusBadge(s.status);
  const toggle =
    isHead && historyCount > 0
      ? `<button class="si-toggle" data-head="${s.id}" title="${expanded ? '收起' : '展开'}历史">
          <span class="si-toggle-caret">${expanded ? '▾' : '▸'}</span>
          <span class="si-toggle-count">${historyCount}</span>
        </button>`
      : '';
  const headAttr = !isHead && headId ? ` data-history-of="${headId}"` : '';
  return `
    <li class="${classes.join(' ')}${hidden}" data-id="${s.id}"${headAttr}>
      <div class="si-name">
        ${toggle}
        <span class="si-name-text">${escapeHtml(s.name)}</span>${status}
        <button class="si-delete" data-del="${s.id}" title="删除会话">×</button>
      </div>
      <div class="si-meta">${escapeHtml(s.workdir)}</div>
    </li>`;
}

function renderStatusBadge(status) {
  const map = {
    idle: ['空闲', 'idle'],
    running: ['运行中', 'running'],
    waiting: ['等待授权', 'waiting'],
    error: ['错误', 'error'],
    ended: ['已结束', 'ended'],
  };
  const [text, cls] = map[status] || [status, 'idle'];
  return `<span class="status-pill ${cls}">${text}</span>`;
}

// ===== Sessions =====
function openNewSessionDialog() {
  $('#dlgWorkdir').value = state.cwd;
  $('#dlgPolicy').value = 'balanced';
  $('#dlgName').value = '';
  $('#newSessionDialog').showModal();
}
async function submitNewSession(e) {
  e.preventDefault();
  const body = {
    name: $('#dlgName').value || undefined,
    workdir: $('#dlgWorkdir').value,
    policyId: $('#dlgPolicy').value,
  };
  try {
    const resp = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
    $('#newSessionDialog').close();
    await refreshSessions();
    selectSession(resp.session.id);
  } catch (err) {
    alert('创建会话失败：' + err.message);
  }
}

async function selectSession(id) {
  state.activeSessionId = id;
  state.selectedChangeIdx = 0;
  state.selectedTreePath = null;
  state.structureCache = null;
  state.graphCache = null;
  state.graphSelectedId = null;
  state.codeMapCache = null;
  state.codeMapSelected = null;
  state.codeMapExpanded = new Set();
  state.gitNexusStatus = null;
  state.gitNexusCallGraph = null;
  state.gitNexusGraphSelectedId = null;
  state.gitNexusProcesses = null;
  state.gitNexusImpact = null;
  state.gitNexusImpactSymbol = '';
  state.gitNexusAnalyzing = false;
  state.gitNexusLog = [];
  state.gitNexusHierarchy = null;
  state.gitNexusHierarchyRoot = [];
  state.gitNexusHierarchySelected = null;
  state.gitNexusHierarchyHover = null;
  state.approvalRenderSig = null;
  await loadDetail();
  renderSessionList();
  renderAll();
}

async function loadDetail() {
  if (!state.activeSessionId) {
    state.detail = null;
    return;
  }
  state.detail = await api(`/api/sessions/${state.activeSessionId}`);
  $('#policySelect').value = state.detail.session.policyId;
}

function handleSessionEvent(evt) {
  if (!state.detail) return;
  state.detail.events.push(evt);

  if (evt.type === 'tool:use' || evt.type === 'approval:resolved') {
    const tools = state.detail.tools;
    const i = tools.findIndex((t) => t.id === evt.id || t.id === evt.toolUseId);
    if (evt.type === 'tool:use') {
      if (i === -1) tools.push(evt);
      else tools[i] = evt;
    } else if (i !== -1) {
      tools[i].decision = evt.decision;
      tools[i].manualNote = evt.note;
      tools[i].manualResolution = evt.decision;
    }
  }
  if (evt.type === 'turn:changes' && evt.files && evt.files.length > 0) {
    state.detail.changes.push({ turnId: evt.turnId, timestamp: evt.ts, files: evt.files });
    state.structureCache = null;
    state.graphCache = null;
    state.codeMapCache = null;
    state.gitNexusCallGraph = null;
    state.gitNexusProcesses = null;
    state.gitNexusImpact = null;
    state.gitNexusStatus = null; // index becomes stale
    state.gitNexusHierarchy = null;
    state.gitNexusHierarchyRoot = [];
    state.gitNexusHierarchySelected = null;
    state.gitNexusHierarchyHover = null;
  }
  if (evt.type === 'turn:start') {
    state.detail.turns.push({
      id: evt.turnId,
      prompt: evt.prompt,
      startedAt: evt.ts,
      endedAt: null,
      status: 'running',
      policyId: evt.policyId,
    });
  }
  if (evt.type === 'turn:end') {
    const t = state.detail.turns.find((x) => x.id === evt.turnId);
    if (t) {
      t.endedAt = evt.ts;
      t.status = evt.status;
    }
  }
  if (evt.type === 'approval:pending') {
    if (!state.detail.pendingApprovals.some((a) => a.id === evt.toolUseId)) {
      state.detail.pendingApprovals.push({
        id: evt.toolUseId,
        tool: evt.tool,
        input: evt.input,
        reason: evt.reason,
        memoryHint: evt.memoryHint || null,
        deciderState: null,
      });
    }
  }
  if (evt.type === 'approval:resolved') {
    state.detail.pendingApprovals = state.detail.pendingApprovals.filter(
      (a) => a.id !== evt.toolUseId,
    );
  }
  if (evt.type === 'memory:deciding') {
    const a = state.detail.pendingApprovals.find((x) => x.id === evt.toolUseId);
    if (a) a.deciderState = 'pending';
  }
  if (evt.type === 'memory:decision-uncertain') {
    const a = state.detail.pendingApprovals.find((x) => x.id === evt.toolUseId);
    if (a) {
      a.deciderState = 'uncertain';
      a.deciderReason = evt.reason || '';
      a.deciderConfidence = evt.confidence || 0;
    }
  }
  if (evt.type === 'memory:decision-error' || evt.type === 'memory:decider-skipped') {
    const a = state.detail.pendingApprovals.find((x) => x.id === evt.toolUseId);
    if (a) {
      a.deciderState = 'error';
      a.deciderReason = evt.reason || '';
    }
  }

  renderViewIfActive();
}

// ===== Views =====
function switchView(name) {
  state.view = name;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.remove('hidden');
  renderViewIfActive();
}

function renderAll() {
  renderTopbar();
  renderViewIfActive();
  renderTerminal();
}

function renderViewIfActive() {
  if (state.view === 'chat') renderChatView();
  else if (state.view === 'changes') renderChangesView();
  else if (state.view === 'structure') {
    if (state.structureTab === 'tree') {
      if (!state.structureCache) loadStructure();
      else renderStructureView();
    } else if (state.structureTab === 'modules') {
      if (!state.graphCache) loadDesignGraph();
      else renderModuleGraph();
    } else if (state.structureTab === 'codemap') {
      if (!state.codeMapCache) loadCodeMap();
      else renderCodeMapView();
    } else if (state.structureTab === 'gitnexus') {
      enterGitNexusTab();
    }
  } else if (state.view === 'audit') renderAuditView();
  else if (state.view === 'policy') renderPolicyView();
  else if (state.view === 'memory') {
    if (!state.memory) loadMemory();
    else renderMemoryView();
  }
}

function switchStructureTab(tab) {
  state.structureTab = tab;
  $$('#structureTabs .tab-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab),
  );
  $('#structureBody-tree').classList.toggle('hidden', tab !== 'tree');
  $('#structureBody-modules').classList.toggle('hidden', tab !== 'modules');
  $('#structureBody-codemap').classList.toggle('hidden', tab !== 'codemap');
  $('#structureBody-gitnexus').classList.toggle('hidden', tab !== 'gitnexus');
  renderViewIfActive();
}

function renderTopbar() {
  if (!state.detail) {
    $('#sessionTitle').textContent = '未选择会话';
    $('#sessionMeta').textContent = '';
    $('#statusPill').textContent = '';
    $('#statusPill').className = 'status-pill';
    $('#cancelBtn').disabled = true;
    $('#cancelBtn').textContent = '停止';
    $('#newTaskBtn').disabled = true;
    return;
  }
  const s = state.detail.session;
  $('#sessionTitle').textContent = s.name;
  const metaParts = [s.workdir, `${s.turnCount} 轮`, `${s.changeCount} 个变更文件`];
  if (s.goal) {
    const g = s.goal;
    const tag = g.active
      ? `YOLO·${g.phaseLabel || g.phase}（第 ${g.iteration}/${g.maxIterations} 次）`
      : `YOLO·${g.phaseLabel || g.phase}${g.reason ? '（' + g.reason + '）' : ''}`;
    metaParts.push(tag);
  } else if (s.policyId === 'yolo') {
    metaParts.push('YOLO·待启动（发送任务即开始自动闭环）');
  }
  $('#sessionMeta').textContent = metaParts.join(' · ');
  $('#statusPill').textContent = labelFor(s.status);
  $('#statusPill').className = `status-pill ${s.status}`;
  // Stop button: enabled while a turn is in flight (including waiting on
  // approval). While 'cancelling', show progress text and disable to avoid
  // re-clicks racing with the kill escalation.
  const cancelBtn = $('#cancelBtn');
  if (s.status === 'cancelling') {
    cancelBtn.disabled = true;
    cancelBtn.textContent = '停止中…';
  } else {
    cancelBtn.disabled = s.status !== 'running' && s.status !== 'waiting';
    cancelBtn.textContent = '停止';
  }
  // Next task: enabled only when nothing is running. The session must also
  // not be 'ended' permanently — but ended is fine because we're spinning up
  // a fresh session anyway.
  $('#newTaskBtn').disabled = s.status === 'running' || s.status === 'waiting' || s.status === 'cancelling';
  $('#policySelect').value = s.policyId;
}
function labelFor(status) {
  return {
    idle: '空闲', running: '运行中', waiting: '等待授权',
    cancelling: '停止中', cancelled: '已取消',
    error: '错误', ended: '已结束',
  }[status] || status;
}

// ===== Chat view =====
// Auto-scroll-to-bottom rule: only stick to the bottom if the user was
// already there (within ~24px) right before this re-render. As soon as the
// user scrolls up the gap exceeds the threshold and auto-scroll suspends;
// scrolling back near the bottom re-arms it. No manual flag needed —
// scrollTop is the source of truth.
const STICK_BOTTOM_THRESHOLD_PX = 24;
function isPaneAtBottom(pane) {
  return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= STICK_BOTTOM_THRESHOLD_PX;
}

function renderChatView() {
  const pane = $('#chatPane');
  if (!state.detail) {
    pane.innerHTML = '<div class="empty">选择或创建一个会话以开始</div>';
    $('#approvalPane').innerHTML = '';
    return;
  }
  const wasAtBottom = isPaneAtBottom(pane);
  const events = state.detail.events;
  const tools = new Map(state.detail.tools.map((t) => [t.id, t]));
  const items = [];
  let currentTurn = null;
  for (const e of events) {
    if (e.type === 'turn:start') {
      currentTurn = e.turnId;
      items.push({
        kind: 'divider',
        text: `第 ${e.turnId} 轮 · ${fmtTime(e.ts)}`,
      });
      // AUQ 接续轮的 prompt 已经在 approval:resolved 那里以「我的回答」回显
      // 过，跳过重复的 user 气泡。
      if (!e.fromAUQ) items.push({ kind: 'user', text: e.prompt, ts: e.ts });
    } else if (e.type === 'assistant:text') {
      items.push({ kind: 'assistant', text: e.text, ts: e.ts });
    } else if (e.type === 'assistant:thinking') {
      items.push({ kind: 'thinking', text: e.text, ts: e.ts });
    } else if (e.type === 'tool:use') {
      const decision = e.decision || (tools.get(e.id) || {}).decision || 'manual';
      items.push({
        kind: 'tool',
        tool: e.tool,
        input: e.input,
        decision,
        reason: e.reason,
        ts: e.ts,
        id: e.id,
      });
    } else if (e.type === 'tool:result') {
      items.push({
        kind: 'tool-result',
        text: e.content,
        isError: e.isError,
        ts: e.ts,
      });
    } else if (e.type === 'turn:result') {
      if (e.cost != null || e.durationMs != null) {
        items.push({
          kind: 'system',
          text: `本轮完成 · ${(e.durationMs || 0)}ms${e.cost != null ? ` · $${(e.cost).toFixed(4)}` : ''}`,
          ts: e.ts,
        });
      }
    } else if (e.type === 'cli:stderr') {
      items.push({ kind: 'system', text: 'stderr: ' + e.text, ts: e.ts, error: true });
    } else if (e.type === 'turn:error') {
      items.push({ kind: 'system', text: '错误: ' + e.error, ts: e.ts, error: true });
    } else if (e.type === 'turn:cancel') {
      items.push({ kind: 'system', text: '已请求停止…', ts: e.ts });
    } else if (e.type === 'turn:end' && e.status === 'cancelled') {
      items.push({ kind: 'system', text: '本轮已取消', ts: e.ts });
    } else if (e.type === 'system' && e.subtype === 'init') {
      items.push({
        kind: 'system',
        text: `Claude session ${e.raw?.session_id || ''} 已初始化`,
        ts: e.ts,
      });
    } else if (e.type === 'goal:start') {
      items.push({
        kind: 'system',
        text: `YOLO 闭环启动 · 目标：${truncate(e.task || '', 160)}${e.guidanceLoaded ? ' · 已加载用户偏好' : ''}${e.cleanedArtefacts && e.cleanedArtefacts.length ? ' · 已清理：' + e.cleanedArtefacts.join('/') : ''}`,
        ts: e.ts,
      });
    } else if (e.type === 'goal:phase') {
      const label = { planning: '规划', developing: '开发', testing: '测试', evaluating: '评估' }[e.phase] || e.phase;
      items.push({
        kind: 'system',
        text: `YOLO 进入「${label}」阶段（迭代 ${e.iteration || 0}）${e.reason ? ' · ' + e.reason : ''}`,
        ts: e.ts,
      });
    } else if (e.type === 'goal:test-pass') {
      items.push({ kind: 'system', text: 'YOLO 测试全部 PASS', ts: e.ts });
    } else if (e.type === 'goal:test-fail') {
      items.push({
        kind: 'system',
        text: 'YOLO 测试 FAIL：' + (Array.isArray(e.failures) ? e.failures.join('；') : '未知'),
        ts: e.ts, error: true,
      });
    } else if (e.type === 'goal:eval-fail') {
      items.push({
        kind: 'system',
        text: 'YOLO 评估未达成：' + (Array.isArray(e.gaps) ? e.gaps.join('；') : '未知'),
        ts: e.ts, error: true,
      });
    } else if (e.type === 'goal:done') {
      items.push({ kind: 'system', text: '✓ YOLO 目标达成，闭环结束' + (e.reason ? '（' + e.reason + '）' : ''), ts: e.ts });
    } else if (e.type === 'goal:failed') {
      items.push({ kind: 'system', text: '✗ YOLO 闭环停止：' + (e.reason || '未知'), ts: e.ts, error: true });
    } else if (e.type === 'goal:aborted') {
      items.push({ kind: 'system', text: 'YOLO 闭环已手动停止' + (e.reason ? '（' + e.reason + '）' : ''), ts: e.ts });
    } else if (e.type === 'goal:warning') {
      items.push({ kind: 'system', text: 'YOLO 提示：' + (e.message || ''), ts: e.ts });
    } else if (e.type === 'approval:resolved') {
      // AUQ 回答即时回显：避免提交后到下一轮 turn:start 之间留白，让用户
      // 立刻看到自己选了什么；非 AUQ 的审批不在聊天流里渲染（仍属审计）。
      const auq = Array.isArray(e.auqAnswers) ? e.auqAnswers : null;
      const noteText = (e.note || '').trim();
      const hasAUQ = auq && auq.length > 0;
      if (hasAUQ || (noteText && e.decision === 'auto')) {
        const lines = [];
        if (hasAUQ) {
          for (const a of auq) {
            const q = (a.question || '').trim();
            const picks = Array.isArray(a.picked) ? a.picked.join(' / ') : '';
            lines.push(`• ${q || '（无问题文本）'}\n  → ${picks || '（未选）'}`);
          }
        } else if (noteText) {
          lines.push(noteText);
        }
        items.push({
          kind: 'user',
          text: '我的回答：\n' + lines.join('\n'),
          ts: e.ts,
        });
      }
    }
  }

  pane.innerHTML = items.map(renderChatItem).join('') ||
    '<div class="empty">输入下方框开始你的第一轮对话</div>';
  if (wasAtBottom) pane.scrollTop = pane.scrollHeight;

  // Approval panel
  // 每个后端事件都会触发 renderChatView，所以这里每次都会重写 approval pane
  // 的 innerHTML —— 不做防护的话，用户正在 AUQ 卡片里选的 .selected chip
  // 和已填的 textarea 会被瞬间清空，体感是「我刚选完就被覆盖了」。
  // 这里改为「签名匹配 + 局部更新」：
  //   ① 卡片 id 集合没变 → 不动 DOM，只在 decider 状态变化时改 decider bar；
  //      textarea 的 value / 焦点 / 光标位置完全不受影响。
  //   ② 卡片 id 集合变了 → 仍用 snapshot + 全量重写，并把焦点 / 光标还原。
  renderApprovalPane();
  insertDepositButtons();
}

function renderApprovalPane() {
  const pane = $('#approvalPane');
  if (!pane) return;
  const approvals = (state.detail && state.detail.pendingApprovals) || [];
  const newSig = approvalSignature(approvals);
  const oldSig = state.approvalRenderSig;

  if (approvals.length === 0) {
    if (pane.innerHTML !== '') pane.innerHTML = '';
    state.approvalRenderSig = '';
    return;
  }

  if (sameApprovalIdSet(oldSig, newSig)) {
    updateDeciderBars(approvals);
    state.approvalRenderSig = newSig;
    return;
  }

  const snap = snapshotApprovalPaneState();
  pane.innerHTML = renderApprovalShell(approvals);
  wireApprovalShell();
  restoreApprovalPaneState(snap);
  state.approvalRenderSig = newSig;
}

function approvalSignature(approvals) {
  return approvals.map((a) => `${a.id}:${a.deciderState || ''}`).join('|');
}
function sameApprovalIdSet(oldSig, newSig) {
  if (oldSig == null) return false;
  const ids = (sig) => (sig || '').split('|').map((s) => s.split(':')[0]).join(',');
  return ids(oldSig) === ids(newSig);
}

// Surgical update when the same approvals are still pending but their decider
// state changed (memory:deciding → memory:decision-uncertain). 不重写整个 pane，
// 只换 decider-bar 槽位 —— 这样 textarea 焦点 / 光标 / 在敲的内容都不会被打断。
function updateDeciderBars(approvals) {
  const pane = $('#approvalPane');
  if (!pane) return;
  for (const a of approvals) {
    const card = pane.querySelector(`.approval-card[data-id="${a.id}"]`);
    if (!card) continue;
    card.classList.toggle('approval-decider-pending', a.deciderState === 'pending');
    card.classList.toggle('approval-decider-uncertain', a.deciderState === 'uncertain');
    const slot = card.querySelector('.approval-decider-bar-slot');
    if (slot) slot.innerHTML = renderDeciderBar(a);
  }
  $$('.cancel-decider-btn', pane).forEach((btn) => {
    btn.onclick = () => cancelDecider(btn.dataset.id);
  });
}

// Single shell containing all pending approvals + one bottom submit button.
// 用户的原话：「最终只需要一个最终的提交按钮」——所以每张卡片不再有独立的
// 「通过 / 拒绝 / 提交回答并继续」，而是把决定收敛成一行 chip，由壳层统一提交。
function renderApprovalShell(approvals) {
  const cards = approvals.map(renderApprovalCard).join('');
  return `
    <div class="approval-shell">
      <div class="approval-shell-head">
        <span class="approval-shell-title">⏸ 等你回答 · 共 ${approvals.length} 项</span>
        <span class="muted">逐项作答后点击下方「提交全部」一次性发送</span>
      </div>
      <div class="approval-shell-body">${cards}</div>
      <div class="approval-shell-footer">
        <button type="button" class="primary-btn approval-submit-all">提交全部</button>
        <button type="button" class="ghost-btn approval-reject-all">全部拒绝</button>
      </div>
    </div>`;
}

function snapshotApprovalPaneState() {
  const pane = $('#approvalPane');
  if (!pane) return null;
  const snap = { cards: {}, focus: null };
  const active = document.activeElement;
  if (active && pane.contains(active)) {
    const card = active.closest('.approval-card');
    if (card?.dataset.id && active.tagName === 'TEXTAREA') {
      let kind = null;
      let key = null;
      if (active.dataset.note) { kind = 'note'; key = active.dataset.note; }
      else if (active.dataset.qi != null) { kind = 'qi'; key = active.dataset.qi; }
      if (kind) {
        snap.focus = {
          cardId: card.dataset.id,
          kind,
          key,
          selStart: active.selectionStart,
          selEnd: active.selectionEnd,
        };
      }
    }
  }
  pane.querySelectorAll('.approval-card').forEach((card) => {
    const id = card.dataset.id;
    if (!id) return;
    const selections = [];
    card.querySelectorAll('.auq-option.selected').forEach((b) => {
      selections.push({ qi: b.dataset.q, opt: b.dataset.opt });
    });
    const decision = card.querySelector('.approval-decision-chip.selected')?.dataset.decision || null;
    const texts = {};
    card.querySelectorAll('textarea').forEach((t) => {
      let key = '';
      if (t.dataset.note) key = 'note:' + t.dataset.note;
      else if (t.dataset.qi != null) key = 'qi:' + t.dataset.qi;
      if (key) texts[key] = t.value;
    });
    snap.cards[id] = { selections, decision, texts };
  });
  return snap;
}

function restoreApprovalPaneState(snap) {
  if (!snap) return;
  const pane = $('#approvalPane');
  if (!pane) return;
  for (const id in snap.cards) {
    const card = pane.querySelector(`.approval-card[data-id="${id}"]`);
    if (!card) continue;
    const s = snap.cards[id];
    for (const { qi, opt } of s.selections) {
      const btn = card.querySelector(`.auq-option[data-q="${qi}"][data-opt="${opt}"]`);
      if (btn) btn.classList.add('selected');
    }
    if (s.decision) {
      const dec = card.querySelector(`.approval-decision-chip[data-decision="${s.decision}"]`);
      if (dec) dec.classList.add('selected');
    }
    for (const key in s.texts) {
      const sepIdx = key.indexOf(':');
      const kind = key.slice(0, sepIdx);
      const k = key.slice(sepIdx + 1);
      const sel = kind === 'note'
        ? `textarea[data-note="${k}"]`
        : `textarea[data-qi="${k}"]`;
      const t = card.querySelector(sel);
      if (t) t.value = s.texts[key];
    }
  }
  if (snap.focus) {
    const { cardId, kind, key, selStart, selEnd } = snap.focus;
    const card = pane.querySelector(`.approval-card[data-id="${cardId}"]`);
    const sel = kind === 'note'
      ? `textarea[data-note="${key}"]`
      : `textarea[data-qi="${key}"]`;
    const el = card?.querySelector(sel);
    if (el) {
      el.focus();
      try { el.setSelectionRange(selStart, selEnd); } catch {}
    }
  }
}

// Approval card rendering. AskUserQuestion gets an interactive form (option
// chips + free-text per question); other tools get the normal approve/reject
// pair plus an optional note textarea so the user can always type something
// custom before approving — auto policies never silently swallow these.
function renderApprovalCard(a) {
  if (a.tool === 'AskUserQuestion') return renderAskUserQuestionCard(a);
  const cls = ['approval-card'];
  if (a.deciderState === 'pending') cls.push('approval-decider-pending');
  if (a.deciderState === 'uncertain') cls.push('approval-decider-uncertain');
  // 「授权也可以看成一种特殊的选择」：用与 AUQ 一致的 chip 风格让用户选
  // 「通过 / 拒绝」，提交统一交给壳层底部的「提交全部」。
  return `
    <div class="${cls.join(' ')}" data-id="${a.id}" data-kind="tool">
      <div class="approval-title">⚠ 等待人工授权 · 工具：${escapeHtml(a.tool)}</div>
      <div class="muted">${escapeHtml(a.reason || '')}</div>
      <div class="approval-decider-bar-slot">${renderDeciderBar(a)}</div>
      ${renderMemoryHint(a)}
      <div class="approval-input">${escapeHtml(JSON.stringify(a.input, null, 2))}</div>
      <div class="approval-decision">
        <span class="approval-decision-label">你的决定</span>
        <div class="approval-decision-chips" data-decision-for="${a.id}">
          <button type="button" class="approval-decision-chip" data-decision="approve" data-id="${a.id}">通过</button>
          <button type="button" class="approval-decision-chip reject" data-decision="reject" data-id="${a.id}">拒绝</button>
        </div>
      </div>
      <textarea class="approval-note" data-note="${a.id}"
        placeholder="（可选）写下要附带的备注，会随本次决定一起记录…" rows="2"></textarea>
    </div>`;
}

function renderDeciderBar(a) {
  if (a.deciderState === 'pending') {
    return `<div class="approval-decider-bar pending">
      <span class="spinner"></span>
      <span>记忆助手判断中…</span>
      <button class="ghost-btn cancel-decider-btn" data-id="${a.id}">我自己决定</button>
    </div>`;
  }
  if (a.deciderState === 'uncertain') {
    return `<div class="approval-decider-bar uncertain">
      <span>🤔 记忆助手不确定（${(a.deciderConfidence ?? 0).toFixed(2)}）：${escapeHtml(a.deciderReason || '')}</span>
    </div>`;
  }
  if (a.deciderState === 'error') {
    return `<div class="approval-decider-bar error">
      <span>记忆助手未给出建议（${escapeHtml(a.deciderReason || 'error')}）</span>
    </div>`;
  }
  return '';
}

function renderMemoryHint(a) {
  if (!a.memoryHint) return '';
  const c = a.memoryHint.counts || {};
  return `<div class="approval-memory-hint">
    历次记忆：${c.approve || 0}✓ / ${c.reject || 0}✗
    ${a.memoryHint.frozen ? '<span class="muted">（已冻结）</span>' : ''}
    <a href="#" data-mem-link="${a.memoryHint.entryId}">查看</a>
  </div>`;
}

function renderAskUserQuestionCard(a) {
  const input = a.input || {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const blocks = questions.map((q, i) => {
    const opts = Array.isArray(q.options) ? q.options : [];
    const optionChips = opts
      .map(
        (o, j) => `
          <button type="button" class="auq-option" data-q="${i}" data-opt="${j}"
            data-label="${escapeHtml(o.label || '')}" title="${escapeHtml(o.description || '')}">
            ${escapeHtml(o.label || '')}
          </button>`,
      )
      .join('');
    return `
      <div class="auq-question" data-qi="${i}">
        <div class="auq-q-head">
          ${q.header ? `<span class="auq-header">${escapeHtml(q.header)}</span>` : ''}
          <span class="auq-q-text">${escapeHtml(q.question || '')}</span>
          ${q.multiSelect ? '<span class="auq-multi">可多选</span>' : ''}
        </div>
        ${optionChips ? `<div class="auq-options">${optionChips}</div>` : ''}
        <textarea class="auq-input" data-qi="${i}"
          placeholder="或在此自由输入你的回答…" rows="2"></textarea>
      </div>`;
  }).join('');

  const cls = ['approval-card', 'auq-card'];
  if (a.deciderState === 'pending') cls.push('approval-decider-pending');
  if (a.deciderState === 'uncertain') cls.push('approval-decider-uncertain');
  return `
    <div class="${cls.join(' ')}" data-id="${a.id}" data-kind="auq">
      <div class="approval-title">？ Claude 在等你回答 · AskUserQuestion</div>
      <div class="muted">逐题选择或自由输入；与其他待办合并后，点击下方「提交全部」一次性发送给 Claude。</div>
      <div class="approval-decider-bar-slot">${renderDeciderBar(a)}</div>
      ${renderMemoryHint(a)}
      <div class="auq-questions">${blocks || '<div class="muted">（没有结构化问题，可在备注里直接回答）</div>'}</div>
      <textarea class="approval-note" data-note="${a.id}"
        placeholder="（可选）总体备注…" rows="2"></textarea>
    </div>`;
}

function wireApprovalShell() {
  const pane = $('#approvalPane');
  if (!pane) return;

  // AskUserQuestion: option chip toggles selection (single or multi).
  $$('.auq-option', pane).forEach((btn) => {
    btn.addEventListener('click', () => {
      const qi = btn.dataset.q;
      const card = btn.closest('.auq-card');
      cancelDeciderIfPending(card);
      const questionEl = card.querySelector(`.auq-question[data-qi="${qi}"]`);
      const multi = questionEl.querySelector('.auq-multi') != null;
      if (!multi) {
        questionEl.querySelectorAll('.auq-option').forEach((b) => b.classList.remove('selected'));
      }
      btn.classList.toggle('selected');
    });
  });

  // Plain tool decision chips ——「授权」也是一种 chip 选择，互斥单选。
  $$('.approval-decision-chip', pane).forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.approval-card');
      cancelDeciderIfPending(card);
      card.querySelectorAll('.approval-decision-chip').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });

  // One submit button for the whole shell.
  const submitBtn = pane.querySelector('.approval-submit-all');
  if (submitBtn) submitBtn.addEventListener('click', submitAllApprovals);
  const rejectBtn = pane.querySelector('.approval-reject-all');
  if (rejectBtn) rejectBtn.addEventListener('click', rejectAllApprovals);

  $$('.cancel-decider-btn', pane).forEach((btn) => {
    btn.addEventListener('click', () => cancelDecider(btn.dataset.id));
  });

  $$('a[data-mem-link]', pane).forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      switchView('memory');
    });
  });
}

// 用户开始动手作答时，立刻取消同卡片仍在飞行中的后台 decider，避免 decider
// 在用户点完选项还没点提交前就抢先 resolveApproval 触发下一轮。
function cancelDeciderIfPending(card) {
  if (card?.classList.contains('approval-decider-pending') && card.dataset.id) {
    cancelDecider(card.dataset.id);
  }
}

function readApprovalNote(id) {
  const t = $(`.approval-note[data-note="${id}"]`, $('#approvalPane'));
  return t ? t.value.trim() : '';
}

// Collect this card's AUQ answers. Returns {complete, note, auqAnswers}.
function collectAuqCardAnswer(card) {
  const lines = [];
  const auqAnswers = [];
  let hasAny = false;
  card.querySelectorAll('.auq-question').forEach((qEl) => {
    const head = qEl.querySelector('.auq-q-text')?.textContent?.trim() || '';
    const picked = Array.from(qEl.querySelectorAll('.auq-option.selected'))
      .map((b) => b.dataset.label)
      .filter(Boolean);
    const custom = qEl.querySelector('.auq-input')?.value?.trim() || '';
    const parts = [];
    if (picked.length) parts.push(picked.join(' / '));
    if (custom) parts.push(custom);
    if (parts.length) {
      lines.push(`• ${head}\n  → ${parts.join(' | ')}`);
      hasAny = true;
    }
    if (picked.length) auqAnswers.push({ question: head, picked });
  });
  const noteText = readApprovalNote(card.dataset.id);
  if (noteText) {
    lines.push(`备注：${noteText}`);
    hasAny = true;
  }
  return {
    complete: hasAny,
    note: lines.join('\n'),
    auqAnswers,
  };
}

function collectToolCardAnswer(card) {
  const decision = card.querySelector('.approval-decision-chip.selected')?.dataset.decision || '';
  return {
    complete: decision === 'approve' || decision === 'reject',
    decision,
    note: readApprovalNote(card.dataset.id),
  };
}

// 「在全部选择完成之前，不能触发当前进度继续」：先校验每张卡片都已作答，
// 任意一张未作答就高亮提示并直接返回，不发任何请求；全部就绪后再统一提交。
function submitAllApprovals() {
  const pane = $('#approvalPane');
  if (!pane) return;
  const approvals = (state.detail && state.detail.pendingApprovals) || [];
  if (approvals.length === 0) return;

  // Validation pass — fail fast before any network call.
  const plans = [];
  for (const a of approvals) {
    const card = pane.querySelector(`.approval-card[data-id="${a.id}"]`);
    if (!card) continue;
    card.classList.remove('approval-card-missing');
    if (a.tool === 'AskUserQuestion') {
      const r = collectAuqCardAnswer(card);
      if (!r.complete) {
        card.classList.add('approval-card-missing');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        alert(`「${a.tool}」尚未作答：请至少选择一个选项或填写回答 / 备注`);
        return;
      }
      plans.push({ id: a.id, action: 'approve', note: r.note, auqAnswers: r.auqAnswers });
    } else {
      const r = collectToolCardAnswer(card);
      if (!r.complete) {
        card.classList.add('approval-card-missing');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        alert(`「${a.tool}」尚未作答：请先选择「通过」或「拒绝」`);
        return;
      }
      plans.push({ id: a.id, action: r.decision, note: r.note, auqAnswers: null });
    }
  }

  // All clear — fire resolveApproval for each. They run independently; the
  // backend uses each toolUseId so order across the wire doesn't matter.
  for (const p of plans) {
    resolveApproval(p.id, p.action, p.note, p.auqAnswers);
  }
}

function rejectAllApprovals() {
  const approvals = ((state.detail && state.detail.pendingApprovals) || []).slice();
  if (approvals.length === 0) return;
  if (!confirm(`确认对全部 ${approvals.length} 项作答为「拒绝/取消」？`)) return;
  for (const a of approvals) {
    resolveApproval(a.id, 'reject', '', null);
  }
}

function renderChatItem(it) {
  if (it.kind === 'divider') {
    return `<div class="turn-divider">${escapeHtml(it.text)}</div>`;
  }
  if (it.kind === 'user') {
    return msgBlock('user', '我', escapeHtml(it.text), fmtTime(it.ts));
  }
  if (it.kind === 'assistant') {
    return msgBlock('assistant', 'Claude', renderMarkdown(it.text), fmtTime(it.ts));
  }
  if (it.kind === 'thinking') {
    const summary = escapeHtml(truncate(it.text, 80));
    const full = escapeHtml(it.text || '');
    return `
      <div class="msg system">
        <div class="avatar">思</div>
        <div class="body">
          <div class="head"><strong>思考</strong><span class="muted">${fmtTime(it.ts)}</span></div>
          <details class="thinking-details">
            <summary class="thinking-summary">${summary}</summary>
            <div class="thinking-full">${full}</div>
          </details>
        </div>
      </div>`;
  }
  if (it.kind === 'tool') {
    const decisionLabel = {
      auto: '自动允许',
      manual: '等待人工',
      reject: '已拒绝',
    }[it.decision] || it.decision;
    const body = it.tool === 'AskUserQuestion'
      ? renderAskUserQuestionPreview(it.input)
      : it.tool === 'ExitPlanMode'
        ? renderExitPlanModePreview(it.input)
        : `<div class="content">${escapeHtml(truncate(JSON.stringify(it.input, null, 2), 1200))}</div>`;
    return `
      <div class="msg tool ${it.decision}">
        <div class="avatar">⚙</div>
        <div class="body">
          <div class="head">
            <strong>${escapeHtml(it.tool)}</strong>
            <span class="badge">${escapeHtml(decisionLabel)}</span>
            ${it.reason ? `<span class="muted">${escapeHtml(it.reason)}</span>` : ''}
            <span class="muted" style="margin-left:auto">${fmtTime(it.ts)}</span>
          </div>
          ${body}
        </div>
      </div>`;
  }
  if (it.kind === 'tool-result') {
    const text = it.text || '';
    const display = text.length > 3000 ? truncate(text, 3000) : text;
    return msgBlock(
      'tool',
      '结果',
      `<div class="content tool-result-content">${renderMarkdown(display)}</div>`,
      fmtTime(it.ts),
      it.isError ? 'reject' : 'auto',
    );
  }
  if (it.kind === 'system') {
    return msgBlock('system', '系统', `<span class="muted">${escapeHtml(it.text)}</span>`, fmtTime(it.ts));
  }
  return '';
}
// Pretty-print the AskUserQuestion tool input as cards instead of raw JSON,
// so the chat log stays readable when scrolling history.
function renderAskUserQuestionPreview(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (questions.length === 0) {
    return `<div class="content">${escapeHtml(JSON.stringify(input, null, 2))}</div>`;
  }
  const blocks = questions.map((q) => {
    const opts = Array.isArray(q.options) ? q.options : [];
    const optList = opts.map((o) => `
      <li>
        <span class="auq-opt-label">${escapeHtml(o.label || '')}</span>
        ${o.description ? `<span class="auq-opt-desc muted">${escapeHtml(o.description)}</span>` : ''}
      </li>`).join('');
    return `
      <div class="auq-preview-q">
        <div class="auq-q-head">
          ${q.header ? `<span class="auq-header">${escapeHtml(q.header)}</span>` : ''}
          <span class="auq-q-text">${escapeHtml(q.question || '')}</span>
          ${q.multiSelect ? '<span class="auq-multi">可多选</span>' : ''}
        </div>
        ${optList ? `<ul class="auq-opt-list">${optList}</ul>` : ''}
      </div>`;
  }).join('');
  return `<div class="auq-preview">${blocks}</div>`;
}

function renderExitPlanModePreview(input) {
  const plan = typeof input?.plan === 'string' ? input.plan : '';
  if (!plan) {
    return `<div class="content">${escapeHtml(JSON.stringify(input, null, 2))}</div>`;
  }
  return `<div class="content auq-plan">${escapeHtml(truncate(plan, 4000))}</div>`;
}

function msgBlock(role, name, content, ts, extraCls = '') {
  return `
    <div class="msg ${role} ${extraCls}">
      <div class="avatar">${escapeHtml(name.slice(0, 1))}</div>
      <div class="body">
        <div class="head"><strong>${escapeHtml(name)}</strong><span class="muted">${ts || ''}</span></div>
        <div class="content">${content}</div>
      </div>
    </div>`;
}

// ===== Image upload state & helpers =====
const pendingImages = []; // [{ base64, mimeType, name }]
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB per image

function handleImageFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (file.size > MAX_IMAGE_SIZE) {
      alert(`图片 ${file.name} 超过 5MB 限制`);
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      pendingImages.push({ base64, mimeType: file.type, name: file.name });
      renderImagePreviews();
    };
    reader.readAsDataURL(file);
  }
}

function renderImagePreviews() {
  const row = $('#imagePreviewRow');
  if (pendingImages.length === 0) {
    row.classList.add('hidden');
    row.innerHTML = '';
    return;
  }
  row.classList.remove('hidden');
  row.innerHTML = pendingImages.map((img, i) => `
    <div class="image-preview-item">
      <img src="data:${img.mimeType};base64,${img.base64}" alt="${escapeHtml(img.name)}" />
      <button type="button" class="image-remove-btn" onclick="removeImage(${i})">×</button>
    </div>
  `).join('');
}

function removeImage(idx) {
  pendingImages.splice(idx, 1);
  renderImagePreviews();
}
window.removeImage = removeImage;

// Lightbox
function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = `<img src="${src}" class="lightbox-img" /><button class="lightbox-close">×</button>`;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.classList.contains('lightbox-close')) overlay.remove();
  });
  document.body.appendChild(overlay);
}
async function submitPrompt(e) {
  e.preventDefault();
  const txt = $('#promptInput').value.trim();
  if (!txt || !state.activeSessionId) return;
  $('#promptInput').value = '';
  const body = { prompt: txt };
  if (pendingImages.length > 0) {
    body.images = pendingImages.splice(0);
    renderImagePreviews();
  }
  try {
    await api(`/api/sessions/${state.activeSessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (err) {
    alert('发送失败：' + err.message);
  }
}
async function cancelTurn() {
  if (!state.activeSessionId) return;
  try {
    await api(`/api/sessions/${state.activeSessionId}/cancel`, { method: 'POST' });
  } catch (e) {}
}
// Spin up a fresh session reusing the current session's workdir + policy.
// Useful when one task wraps up and the user wants a clean conversation
// context (no --resume) for the next task — skips the dialog. Also extracts
// background / progress / next-step hints from the current session and
// pre-fills the new prompt input so the user only has to edit & send.
async function startNextTask() {
  if (!state.detail) return;
  const cur = state.detail.session;
  const baseName = (cur.name || '').replace(/\s*#\d+$/, '');
  const nextNum = state.sessions.filter((s) => (s.name || '').startsWith(baseName)).length + 1;

  const draft = buildNextTaskDraft(state.detail);
  const body = {
    name: `${baseName} #${nextNum}`,
    workdir: cur.workdir,
    policyId: cur.policyId,
    parentSessionId: cur.id,
  };
  try {
    const resp = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
    state.pendingPromptDraft = { sessionId: resp.session.id, text: draft };
    await refreshSessions();
    selectSession(resp.session.id);
    applyPendingPromptDraft();
    $('#promptInput').focus();
  } catch (err) {
    alert('开启下一任务失败：' + err.message);
  }
}

function applyPendingPromptDraft() {
  const p = state.pendingPromptDraft;
  if (!p || p.sessionId !== state.activeSessionId) return;
  const ta = $('#promptInput');
  if (!ta) return;
  ta.value = p.text;
  const idx = p.text.indexOf(NEXT_TASK_PLACEHOLDER);
  if (idx >= 0) {
    const pos = idx + NEXT_TASK_PLACEHOLDER.length;
    try {
      ta.setSelectionRange(pos, pos);
    } catch {}
  }
  state.pendingPromptDraft = null;
}

const NEXT_TASK_PLACEHOLDER = '（在此填写下一步要交给 Claude 的具体任务……）';

// Build a "handoff" draft prompt that the user can edit before sending.
// Pulls: original prompt (background), latest assistant text (progress),
// and the changed-files list. The next-step section is left as a placeholder
// since Claude's last message rarely encodes a clean "do X next".
function buildNextTaskDraft(detail) {
  const turns = Array.isArray(detail.turns) ? detail.turns : [];
  const events = Array.isArray(detail.events) ? detail.events : [];
  const changes = Array.isArray(detail.changes) ? detail.changes : [];

  const firstPrompt =
    turns.length > 0 && turns[0].prompt ? String(turns[0].prompt).trim() : '';
  const turnCount = turns.length;

  let lastAssistantText = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'assistant:text' && e.text && e.text.trim()) {
      lastAssistantText = e.text.trim();
      break;
    }
  }

  const fileMap = new Map();
  for (const cs of changes) {
    for (const f of cs.files || []) {
      if (f.relPath) fileMap.set(f.relPath, f.kind);
    }
  }
  const fileList = Array.from(fileMap.entries());
  const fileLines = fileList
    .slice(0, 12)
    .map(([rel, kind]) => `- [${kind}] ${rel}`)
    .join('\n');
  const fileMore = fileList.length > 12 ? `\n- …其余 ${fileList.length - 12} 个文件略` : '';

  const bg = firstPrompt ? truncate(firstPrompt, 400) : '（上一任务无初始提示）';
  const progressParts = [];
  progressParts.push(`- 共 ${turnCount} 轮，${fileList.length} 个变更文件`);
  if (fileList.length > 0) progressParts.push(`- 改动文件：\n${fileLines}${fileMore}`);
  if (lastAssistantText) {
    progressParts.push(`- Claude 最终回复：\n${truncate(lastAssistantText, 600)}`);
  }
  const progress = progressParts.join('\n');

  return [
    `# 背景（上一任务）`,
    bg,
    ``,
    `# 已完成进展`,
    progress,
    ``,
    `# 下一步任务`,
    NEXT_TASK_PLACEHOLDER,
    ``,
  ].join('\n');
}
async function changePolicy() {
  if (!state.activeSessionId) return;
  const policyId = $('#policySelect').value;
  await api(`/api/sessions/${state.activeSessionId}/policy`, {
    method: 'POST',
    body: JSON.stringify({ policyId }),
  });
}
async function resolveApproval(id, action, note, auqAnswers) {
  await api(`/api/sessions/${state.activeSessionId}/approve/${id}`, {
    method: 'POST',
    body: JSON.stringify({
      decision: action === 'approve' ? 'auto' : 'reject',
      note: note || '',
      auqAnswers: auqAnswers || null,
    }),
  });
}

async function cancelDecider(toolUseId) {
  if (!state.activeSessionId) return;
  try {
    await api(`/api/sessions/${state.activeSessionId}/approvals/${toolUseId}/cancel-decider`, {
      method: 'POST',
    });
  } catch (e) {
    console.warn('cancel decider failed', e);
  }
}

// ===== Changes view =====
function renderChangesView() {
  const list = $('#changesList');
  const detail = $('#changesDetail');
  if (!state.detail || state.detail.changes.length === 0) {
    list.innerHTML = '<div class="empty">本会话还没有产生代码变更</div>';
    detail.innerHTML = '';
    return;
  }
  // Flatten file-level changes; pair with their turn.
  const flat = [];
  state.detail.changes.forEach((cs, csIdx) => {
    cs.files.forEach((f, fIdx) => {
      flat.push({ turnId: cs.turnId, timestamp: cs.timestamp, file: f, csIdx, fIdx });
    });
  });
  if (state.selectedChangeIdx >= flat.length) state.selectedChangeIdx = flat.length - 1;
  list.innerHTML = flat
    .map(
      (item, i) => `
      <div class="change-card ${i === state.selectedChangeIdx ? 'active' : ''}" data-i="${i}">
        <div class="turn">${escapeHtml(item.turnId)} · ${fmtTime(item.timestamp)}</div>
        <div class="file">
          <span class="kind-badge ${item.file.kind}">${item.file.kind}</span>
          <span>${escapeHtml(item.file.relPath)}</span>
        </div>
      </div>`,
    )
    .join('');
  $$('.change-card', list).forEach((el) =>
    el.addEventListener('click', () => {
      state.selectedChangeIdx = parseInt(el.dataset.i);
      renderChangesView();
    }),
  );

  const picked = flat[state.selectedChangeIdx];
  if (!picked) {
    detail.innerHTML = '';
    return;
  }
  const f = picked.file;
  const diffHtml = (f.diff || [])
    .map((d) => {
      const cls = d.kind === 'add' ? 'add' : d.kind === 'del' ? 'del' : 'eq';
      const prefix = d.kind === 'add' ? '+' : d.kind === 'del' ? '-' : ' ';
      return `<div class="diff-line ${cls}">${escapeHtml(prefix + (d.text || ''))}</div>`;
    })
    .join('');
  detail.innerHTML = `
    <div class="diff-header">
      <span class="kind-badge ${f.kind}">${f.kind}</span>
      ${escapeHtml(f.relPath)}
      <span class="muted" style="margin-left:8px">${escapeHtml(picked.turnId)}</span>
    </div>
    <div class="diff-body">${diffHtml || '<div class="empty">没有可显示的 diff（可能为新增文件或二进制文件）</div>'}</div>
  `;
}

// ===== Structure view =====
async function loadStructure() {
  if (!state.activeSessionId) return;
  const resp = await api(`/api/sessions/${state.activeSessionId}/structure`);
  state.structureCache = resp.tree;
  renderStructureView();
}
function renderStructureView() {
  const container = $('#structureTree');
  if (!state.structureCache) {
    container.innerHTML = '<div class="empty">正在加载结构…</div>';
    return;
  }
  container.innerHTML = renderTreeNode(state.structureCache, true);
  $$('.tree-node', container).forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selectedTreePath = el.dataset.path;
      renderTreeDetail();
      $$('.tree-node', container).forEach((n) => n.style.outline = '');
      el.style.outline = '1px solid var(--accent)';
    }),
  );
  renderTreeDetail();
}
function renderTreeNode(node, isRoot = false) {
  const search = state.structureSearch;
  const matchSelf = !search || (node.name && node.name.toLowerCase().includes(search));
  const isDir = node.type === 'dir';
  const childrenHtml = isDir
    ? (node.children || []).map((c) => renderTreeNode(c)).join('')
    : '';
  const childrenMatch = isDir && childrenHtml.length > 0;
  if (search && !matchSelf && !childrenMatch && !isRoot) return '';

  const changedCls = node.lastChange ? 'changed' : '';
  const changeCount = node.changeCount || 0;
  const dot = node.lastChange || changeCount > 0 ? `<span class="change-dot" title="最近变更"></span>` : '';
  const icon = isDir ? '📁' : '📄';
  return `
    <div>
      <div class="tree-node ${isDir ? 'dir' : 'file'} ${changedCls}" data-path="${escapeHtml(node.relPath || '')}">
        <span class="icon">${icon}</span>
        <span class="name">${escapeHtml(node.name)}</span>
        ${dot}
        ${changeCount ? `<span class="muted">${changeCount}</span>` : ''}
      </div>
      ${isDir ? `<div class="tree-children">${childrenHtml}</div>` : ''}
    </div>`;
}
function renderTreeDetail() {
  const detail = $('#structureDetail');
  const path = state.selectedTreePath;
  if (!path && path !== '') {
    detail.innerHTML = '在左侧选择一个节点查看详情。';
    return;
  }
  // Walk tree to find node
  function find(n) {
    if ((n.relPath || '') === path) return n;
    for (const c of n.children || []) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  }
  const node = find(state.structureCache);
  if (!node) {
    detail.innerHTML = '节点未找到。';
    return;
  }
  // Find related changes for this node
  const relPath = node.relPath || '';
  const related = [];
  for (const cs of state.detail?.changes || []) {
    for (const f of cs.files) {
      if (node.type === 'file' ? f.relPath === relPath : f.relPath.startsWith(relPath + '/')) {
        related.push({ turnId: cs.turnId, timestamp: cs.timestamp, file: f });
      }
    }
  }
  const summarySource = node.type === 'dir' && node.children && node.children.some((c) => c.name && /^README/i.test(c.name))
    ? 'README 首段'
    : node.type === 'dir' ? '目录构成' : '源文件首部注释';
  detail.innerHTML = `
    <h3 style="margin-top:0">${escapeHtml(node.name)}</h3>
    <div class="muted" style="margin-bottom:10px">${escapeHtml(node.relPath || '/')}</div>
    ${node.summary
      ? `<div class="node-summary"><div class="node-summary-label">${escapeHtml(summarySource)}</div><div class="node-summary-text">${escapeHtml(node.summary)}</div></div>`
      : '<div class="node-summary muted"><em>未检测到首部注释或 README，可点击下方让 Claude 解释。</em></div>'}
    <div>类型：${node.type === 'dir' ? '目录' : '文件'}</div>
    ${node.size != null ? `<div>大小：${node.size} bytes</div>` : ''}
    ${node.ext ? `<div>扩展名：.${escapeHtml(node.ext)}</div>` : ''}
    ${node.lastChange
      ? `<div style="margin-top:8px">最近变更：第 ${escapeHtml(node.lastChange.turnId)} 轮（${escapeHtml(node.lastChange.kind)}）</div>`
      : ''}
    ${related.length === 0 ? '' : `
      <h4 style="margin-top:18px">关联变更（${related.length}）</h4>
      <ul style="padding-left:18px;margin:0">
        ${related.map((r) => `
          <li>${escapeHtml(r.turnId)} · ${fmtTime(r.timestamp)} ·
            <span class="kind-badge ${r.file.kind}">${r.file.kind}</span>
            ${escapeHtml(r.file.relPath)}
          </li>`).join('')}
      </ul>`}
    <div class="actions" style="margin-top:18px">
      <button class="primary-btn" id="explainPathBtn">让 Claude 解释这个</button>
    </div>
  `;
  const btn = $('#explainPathBtn', detail);
  if (btn) btn.addEventListener('click', () => prefillExplainPathPrompt(node));
}

// ===== Module dependency graph =====
async function loadDesignGraph() {
  if (!state.activeSessionId) return;
  const info = $('#graphInfo');
  info.textContent = '正在分析模块依赖（madge）…';
  try {
    const resp = await api(`/api/sessions/${state.activeSessionId}/design-graph?type=modules`);
    state.graphCache = resp.graph;
  } catch (e) {
    info.textContent = '加载失败：' + e.message;
    return;
  }
  renderModuleGraph();
}

function renderModuleGraph() {
  const svg = $('#moduleGraph');
  const detail = $('#moduleDetail');
  const info = $('#graphInfo');
  const g = state.graphCache;
  if (!g) {
    svg.innerHTML = '';
    return;
  }
  if (!g.nodes || g.nodes.length === 0) {
    info.textContent = (g.notes || []).join(' · ') || '当前工作目录暂无可分析的模块。';
    svg.innerHTML = '';
    detail.innerHTML = '';
    return;
  }
  info.textContent =
    `语言：${g.language} · 节点 ${g.nodes.length} · 边 ${g.edges.length}` +
    (g.cycles && g.cycles.length ? ` · 循环依赖 ${g.cycles.length}` : '') +
    (g.notes && g.notes.length ? ` · ${g.notes.join('；')}` : '');

  // Apply search filter (dim non-matching nodes)
  const search = state.structureSearch || '';
  const matchSet = new Set();
  for (const n of g.nodes) {
    if (!search || n.relPath.toLowerCase().includes(search) || n.name.toLowerCase().includes(search)) {
      matchSet.add(n.id);
    }
  }

  // Run force-directed layout if not already laid out (or after reload).
  if (!g._laid) layoutForceDirected(g);

  // Render
  const rect = svg.getBoundingClientRect();
  const pad = 30;
  const w = Math.max(rect.width - pad * 2, 200);
  const h = Math.max(rect.height - pad * 2, 200);
  // Compute bbox
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of g.nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const sx = w / Math.max(maxX - minX, 1);
  const sy = h / Math.max(maxY - minY, 1);
  const s = Math.min(sx, sy);
  for (const n of g.nodes) {
    n.px = pad + (n.x - minX) * s;
    n.py = pad + (n.y - minY) * s;
  }

  // Compute neighbor sets for highlight
  const selected = state.graphSelectedId;
  const neighbors = new Set();
  if (selected) {
    neighbors.add(selected);
    for (const e of g.edges) {
      if (e.from === selected) neighbors.add(e.to);
      if (e.to === selected) neighbors.add(e.from);
    }
  }

  const ns = 'http://www.w3.org/2000/svg';
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  // Defs (arrow marker)
  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML = `
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
    </marker>`;
  svg.appendChild(defs);

  // Viewport: pan/zoom transforms apply here, NOT on the svg root, so the
  // root keeps its width/height and pointer events for the pan handler.
  const viewport = document.createElementNS(ns, 'g');
  viewport.setAttribute('class', 'viewport');
  svg.appendChild(viewport);

  // Edges
  const edgeGroup = document.createElementNS(ns, 'g');
  for (const e of g.edges) {
    const a = g.nodes.find((n) => n.id === e.from);
    const b = g.nodes.find((n) => n.id === e.to);
    if (!a || !b) continue;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', a.px);
    line.setAttribute('y1', a.py);
    line.setAttribute('x2', b.px);
    line.setAttribute('y2', b.py);
    line.setAttribute('marker-end', 'url(#arrow)');
    let cls = 'edge';
    if (selected) {
      if (e.from === selected || e.to === selected) cls += ' highlight';
      else cls += ' dim';
    }
    line.setAttribute('class', cls);
    line.setAttribute('color', selected && (e.from === selected || e.to === selected) ? 'var(--accent)' : 'var(--border)');
    edgeGroup.appendChild(line);
  }
  viewport.appendChild(edgeGroup);

  // Nodes
  for (const n of g.nodes) {
    const grp = document.createElementNS(ns, 'g');
    let cls = 'node';
    if (n.lastChange) cls += ' changed';
    if (selected === n.id) cls += ' selected';
    if (selected && !neighbors.has(n.id)) cls += ' dim';
    if (search && !matchSet.has(n.id)) cls += ' dim';
    grp.setAttribute('class', cls);
    grp.setAttribute('transform', `translate(${n.px},${n.py})`);
    grp.dataset.id = n.id;
    grp.style.cursor = 'pointer';

    const r = 5 + Math.min(n.outDeg + n.inDeg, 8);
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('r', r);
    grp.appendChild(c);

    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', r + 4);
    t.setAttribute('y', 3);
    t.textContent = n.name;
    grp.appendChild(t);

    grp.addEventListener('click', () => {
      state.graphSelectedId = state.graphSelectedId === n.id ? null : n.id;
      renderModuleGraph();
    });
    viewport.appendChild(grp);
  }

  attachPanZoom(svg, viewport, g);

  // Detail
  if (selected) {
    const node = g.nodes.find((n) => n.id === selected);
    if (node) {
      const incoming = g.edges.filter((e) => e.to === selected).map((e) => e.from);
      const outgoing = g.edges.filter((e) => e.from === selected).map((e) => e.to);
      const lc = node.lastChange
        ? `<div style="margin-top:8px">最近变更：第 ${escapeHtml(node.lastChange.turnId)} 轮（${escapeHtml(node.lastChange.kind)}）</div>`
        : '';
      detail.innerHTML = `
        <h3 style="margin-top:0">${escapeHtml(node.name)}</h3>
        <div class="muted" style="font-family:var(--mono);font-size:11px;margin-bottom:10px">${escapeHtml(node.relPath)}</div>
        ${node.summary
          ? `<div class="node-summary"><div class="node-summary-label">源文件首部注释</div><div class="node-summary-text">${escapeHtml(node.summary)}</div></div>`
          : '<div class="node-summary muted"><em>未检测到首部注释，可点击下方让 Claude 解释。</em></div>'}
        <div>入度 ${node.inDeg} · 出度 ${node.outDeg}</div>
        ${lc}
        <h4 style="margin-top:14px;margin-bottom:6px">依赖（出 ${outgoing.length}）</h4>
        <ul style="padding-left:18px;margin:0">
          ${outgoing.length === 0 ? '<li class="muted">无</li>' : outgoing.map((d) => `<li><code>${escapeHtml(d)}</code></li>`).join('')}
        </ul>
        <h4 style="margin-top:14px;margin-bottom:6px">被依赖（入 ${incoming.length}）</h4>
        <ul style="padding-left:18px;margin:0">
          ${incoming.length === 0 ? '<li class="muted">无</li>' : incoming.map((d) => `<li><code>${escapeHtml(d)}</code></li>`).join('')}
        </ul>
        <div class="actions" style="margin-top:18px">
          <button class="primary-btn" data-explain-path="${escapeHtml(node.relPath)}">让 Claude 解释这个</button>
        </div>
      `;
      const btn = $('button[data-explain-path]', detail);
      if (btn) btn.addEventListener('click', () => prefillExplainPathPrompt({
        type: 'file',
        name: node.name,
        relPath: node.relPath,
        summary: node.summary,
        ext: node.ext,
      }));
    }
  } else {
    const cycles = g.cycles || [];
    detail.innerHTML = `
      <h3 style="margin-top:0">模块依赖概览</h3>
      <div>语言：${escapeHtml(g.language)}</div>
      <div>共 ${g.nodes.length} 个节点，${g.edges.length} 条依赖边。</div>
      ${cycles.length === 0 ? '<div class="muted" style="margin-top:8px">未发现循环依赖。</div>' : `
        <h4 style="margin-top:14px">循环依赖（${cycles.length}）</h4>
        <ul style="padding-left:18px;margin:0">
          ${cycles.map((c) => `<li><code>${escapeHtml(c.join(' → '))}</code></li>`).join('')}
        </ul>`}
      <p class="muted" style="margin-top:14px">点击任一节点查看入度/出度详情。</p>
    `;
  }
}

// Pan + wheel-zoom for an SVG with a single transformable viewport <g>.
// Stores view state on `g._view` so it survives the click → re-render cycle.
// Pan starts only when pointerdown lands outside any `.node` group, so node
// click handlers continue to work. Zoom anchors at the cursor.
//
// The SVG DOM node may be reused across re-renders (e.g. #moduleGraph lives
// in index.html and survives every renderModuleGraph call), so listeners are
// attached once per element. The current `g` and `viewport` are stashed on
// the element and refreshed each call.
function attachPanZoom(svg, viewport, g) {
  if (!g._view) g._view = { tx: 0, ty: 0, k: 1 };
  const applyTransform = () => {
    const v = svg.__panZoomCtx.g._view;
    svg.__panZoomCtx.viewport.setAttribute('transform', `translate(${v.tx},${v.ty}) scale(${v.k})`);
  };

  if (svg.__panZoomCtx) {
    svg.__panZoomCtx.g = g;
    svg.__panZoomCtx.viewport = viewport;
    applyTransform();
    return;
  }
  svg.__panZoomCtx = { g, viewport };
  applyTransform();

  let dragging = false;
  let last = null;
  let activePointerId = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest && e.target.closest('.node')) return;
    dragging = true;
    last = { x: e.clientX, y: e.clientY };
    activePointerId = e.pointerId;
    try { svg.setPointerCapture(e.pointerId); } catch {}
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const v = svg.__panZoomCtx.g._view;
    v.tx += e.clientX - last.x;
    v.ty += e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    applyTransform();
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    if (activePointerId != null) {
      try { svg.releasePointerCapture(activePointerId); } catch {}
      activePointerId = null;
    }
  };
  svg.addEventListener('pointerup', stop);
  svg.addEventListener('pointercancel', stop);
  svg.addEventListener('pointerleave', stop);

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const v = svg.__panZoomCtx.g._view;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const k0 = v.k;
    const k1 = Math.max(0.2, Math.min(6, k0 * factor));
    v.tx = mx - (mx - v.tx) * (k1 / k0);
    v.ty = my - (my - v.ty) * (k1 / k0);
    v.k = k1;
    applyTransform();
  }, { passive: false });
}

// Simple force-directed layout. Runs synchronously for graphs up to ~300 nodes.
function layoutForceDirected(g) {
  const N = g.nodes.length;
  if (N === 0) return;
  const W = 800, H = 600;
  // Init positions (deterministic seed by id)
  for (const n of g.nodes) {
    if (n.x == null) {
      const seed = hash(n.id);
      n.x = (seed % 1000) / 1000 * W;
      n.y = ((seed >> 10) % 1000) / 1000 * H;
      n.vx = 0;
      n.vy = 0;
    }
  }
  const idx = new Map(g.nodes.map((n, i) => [n.id, i]));
  const k = Math.sqrt((W * H) / Math.max(N, 1));
  const iterations = Math.min(300, 80 + N * 4);
  for (let iter = 0; iter < iterations; iter++) {
    const t = 1 - iter / iterations;
    // Repulsion
    for (let i = 0; i < N; i++) {
      const a = g.nodes[i];
      a.vx = 0; a.vy = 0;
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const b = g.nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) d2 = 0.01;
        const f = (k * k) / d2;
        a.vx += dx * f;
        a.vy += dy * f;
      }
    }
    // Attraction along edges
    for (const e of g.edges) {
      const i = idx.get(e.from);
      const j = idx.get(e.to);
      if (i == null || j == null) continue;
      const a = g.nodes[i];
      const b = g.nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (dist * dist) / k;
      const ux = dx / dist;
      const uy = dy / dist;
      a.vx -= ux * f;
      a.vy -= uy * f;
      b.vx += ux * f;
      b.vy += uy * f;
    }
    // Apply velocity with cooling factor
    const maxStep = k * t;
    for (const n of g.nodes) {
      const v = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 0.01;
      const step = Math.min(v, maxStep);
      n.x += (n.vx / v) * step;
      n.y += (n.vy / v) * step;
      // Keep within bounds
      n.x = Math.max(10, Math.min(W - 10, n.x));
      n.y = Math.max(10, Math.min(H - 10, n.y));
    }
  }
  g._laid = true;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

// ===== Code map view =====
async function loadCodeMap() {
  if (!state.activeSessionId) return;
  $('#codemapOverview').innerHTML = '<div class="muted" style="padding:10px">正在分析代码（typescript compiler API）…</div>';
  $('#codemapTree').innerHTML = '';
  $('#codemapDetail').innerHTML = '';
  try {
    const resp = await api(`/api/sessions/${state.activeSessionId}/code-map`);
    state.codeMapCache = resp.map;
  } catch (e) {
    $('#codemapOverview').innerHTML = `<div class="muted">加载失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  renderCodeMapView();
}

function renderCodeMapView() {
  const m = state.codeMapCache;
  if (!m) return;
  renderCodeMapOverview(m);
  renderCodeMapTree(m);
  renderCodeMapDetail();
}

function renderCodeMapOverview(m) {
  const symById = new Map(m.symbols.map((s) => [s.id, s]));
  const top = (m.keySymbols || []).map((id) => symById.get(id)).filter(Boolean).slice(0, 12);
  $('#codemapOverview').innerHTML = `
    <div class="stat"><div class="num">${m.stats.files}</div><div class="label">files</div></div>
    <div class="stat"><div class="num">${m.stats.symbols}</div><div class="label">symbols</div></div>
    <div class="stat"><div class="num">${m.stats.classes}</div><div class="label">classes</div></div>
    <div class="stat"><div class="num">${m.stats.functions}</div><div class="label">functions</div></div>
    ${m.stats.interfaces ? `<div class="stat"><div class="num">${m.stats.interfaces}</div><div class="label">interfaces</div></div>` : ''}
    <div class="key-symbols">
      <div class="label">关键符号 (按引用排序)</div>
      <div class="key-chips">
        ${top.length === 0 ? '<span class="muted">暂无</span>' : top
          .map((s) => `
            <span class="key-chip" data-id="${s.id}">
              <span class="kind-pill ${s.kind}">${s.kind}</span>
              ${escapeHtml(s.qualifiedName)}
              <span class="muted">${s.refCount || 0}↗</span>
            </span>`)
          .join('')}
      </div>
    </div>`;
  $$('.key-chip', $('#codemapOverview')).forEach((el) =>
    el.addEventListener('click', () => selectCodeMapSymbol(el.dataset.id)),
  );
}

function renderCodeMapTree(m) {
  const search = state.structureSearch || '';
  const symById = new Map(m.symbols.map((s) => [s.id, s]));
  const moduleHtml = m.modules
    .map((mod) => {
      const filesHtml = mod.files
        .map((f) => {
          const fileSyms = f.symbolIds
            .map((id) => symById.get(id))
            .filter((s) => s && !s.parent); // top-level only here
          // Only render file if its symbols (or itself) match search
          if (search) {
            const fmatch = f.relPath.toLowerCase().includes(search);
            const smatch = fileSyms.some((s) => s.qualifiedName.toLowerCase().includes(search));
            if (!fmatch && !smatch) return '';
          }
          const expanded = state.codeMapExpanded.has(`f:${f.relPath}`);
          const symHtml = expanded
            ? fileSyms.map((s) => renderCodeMapSymbolRow(s, m, search)).join('')
            : '';
          const changedCls = f.lastChange ? 'changed' : '';
          const titleAttr = f.summary ? ` title="${escapeHtml(f.summary)}"` : '';
          return `
            <div class="cmt-file">
              <div class="cmt-row ${changedCls}" data-toggle="f:${f.relPath}"${titleAttr}>
                <span class="toggler">${expanded ? '▾' : '▸'}</span>
                <span class="label">📄 ${escapeHtml(f.relPath)}</span>
                <span class="badge-mini">${fileSyms.length}</span>
              </div>
              ${expanded && f.summary ? `<div class="cmt-file-summary">${escapeHtml(f.summary)}</div>` : ''}
              ${expanded ? `<div class="cmt-children">${symHtml}</div>` : ''}
            </div>`;
        })
        .join('');
      const expandedMod = state.codeMapExpanded.has(`m:${mod.name}`);
      return `
        <div class="cmt-module">
          <div class="cmt-row" data-toggle="m:${mod.name}">
            <span class="toggler">${expandedMod ? '▾' : '▸'}</span>
            <span class="label">📦 ${escapeHtml(mod.name)}</span>
            <span class="badge-mini">${mod.fileCount}f / ${mod.symbolCount}s</span>
          </div>
          ${expandedMod ? `<div class="cmt-children">${filesHtml}</div>` : ''}
        </div>`;
    })
    .join('');
  $('#codemapTree').innerHTML = `<div class="cmt-section-label">模块 / 文件 / 符号</div>${moduleHtml}`;
  $$('.cmt-row[data-toggle]').forEach((el) =>
    el.addEventListener('click', () => {
      const k = el.dataset.toggle;
      if (state.codeMapExpanded.has(k)) state.codeMapExpanded.delete(k);
      else state.codeMapExpanded.add(k);
      renderCodeMapTree(m);
    }),
  );
  $$('.cmt-row[data-symbol]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCodeMapSymbol(el.dataset.symbol);
    }),
  );
}

function renderCodeMapSymbolRow(s, m, search) {
  if (search && !s.qualifiedName.toLowerCase().includes(search)) return '';
  const childMembers = (s.members || [])
    .filter((mm) => mm.id)
    .map((mm) => m.symbols.find((x) => x.id === mm.id))
    .filter(Boolean);
  const expanded = state.codeMapExpanded.has(`s:${s.id}`);
  const selected = state.codeMapSelected === s.id ? 'selected' : '';
  const changed = s.lastChange ? 'changed' : '';
  const kindIcon = { class: '🅒', function: 'ƒ', method: '⚡', interface: '🅘', type: '🅣', enum: 'Ⓔ', variable: '𝓿' }[s.kind] || '·';
  return `
    <div class="cmt-symbol">
      <div class="cmt-row ${selected} ${changed}" data-symbol="${s.id}">
        <span class="toggler" data-toggle-sym="s:${s.id}">${childMembers.length ? (expanded ? '▾' : '▸') : ' '}</span>
        <span class="kind-pill ${s.kind}">${kindIcon}</span>
        <span class="label">${escapeHtml(s.name)}</span>
        ${s.exported ? '<span class="badge-mini">exp</span>' : ''}
        ${s.refCount ? `<span class="badge-mini">${s.refCount}↗</span>` : ''}
      </div>
      ${expanded ? `<div class="cmt-children">${
        childMembers.map((c) => renderCodeMapSymbolRow(c, m, search)).join('')
      }</div>` : ''}
    </div>`;
}

function selectCodeMapSymbol(id) {
  state.codeMapSelected = id;
  // Auto-expand parents/file/module so the row is visible
  const m = state.codeMapCache;
  const sym = m && m.symbols.find((s) => s.id === id);
  if (sym) {
    state.codeMapExpanded.add(`f:${sym.relPath}`);
    const top = sym.relPath.includes('/') ? sym.relPath.split('/')[0] : '(root)';
    state.codeMapExpanded.add(`m:${top}`);
    if (sym.parent) state.codeMapExpanded.add(`s:${sym.parent}`);
  }
  renderCodeMapTree(m);
  renderCodeMapDetail();
}

function renderCodeMapDetail() {
  const m = state.codeMapCache;
  const detail = $('#codemapDetail');
  if (!m) {
    detail.innerHTML = '';
    return;
  }
  const id = state.codeMapSelected;
  if (!id) {
    detail.innerHTML = `
      <div class="symbol-detail">
        <h2>代码地图</h2>
        <p class="muted">基于 TypeScript Compiler API 的轻量级符号索引：从 AST 提取模块、类、函数、接口、类型，并基于文本搜索估算引用关系。</p>
        <p class="muted">在左侧选择符号查看其位置、签名、JSDoc、继承关系与跨文件引用；可一键交给 Claude 继续分析。</p>
      </div>`;
    return;
  }
  const s = m.symbols.find((x) => x.id === id);
  if (!s) {
    detail.innerHTML = '<div class="muted">符号未找到。</div>';
    return;
  }
  const parent = s.parent ? m.symbols.find((x) => x.id === s.parent) : null;
  const heritage = (s.heritage || [])
    .map((h) => `<li><span class="badge-mini">${h.kind}</span><code>${escapeHtml(h.name)}</code></li>`)
    .join('');
  const members = (s.members || [])
    .map((mm) => {
      if (mm.id) {
        const child = m.symbols.find((x) => x.id === mm.id);
        return `<li><span class="kind-pill ${mm.kind}">${mm.kind}</span><a data-symbol="${mm.id}">${escapeHtml(mm.name)}</a>${child && child.signature ? '<span class="muted"> — ' + escapeHtml(truncate(child.signature.replace(/\s+/g, ' '), 80)) + '</span>' : ''}</li>`;
      }
      return `<li><span class="kind-pill ${mm.kind}">${mm.kind}</span>${escapeHtml(mm.name)}</li>`;
    })
    .join('');
  const refs = (s.references || []).slice(0, 30);
  const refsHtml = refs
    .map((r) => `<li><code>${escapeHtml(r.relPath)}</code><span class="muted">×${r.count}</span></li>`)
    .join('');
  const lastChangeHtml = s.lastChange
    ? `<div class="meta"><span class="badge-mini">${s.lastChange.kind}</span> 第 ${escapeHtml(s.lastChange.turnId)} 轮变更</div>`
    : '';

  detail.innerHTML = `
    <div class="symbol-detail">
      <h2>
        <span class="kind-pill ${s.kind}">${s.kind}</span>
        ${escapeHtml(s.qualifiedName)}
        ${s.exported ? '<span class="badge-mini">exported</span>' : ''}
      </h2>
      <div class="meta">
        <span><code>${escapeHtml(s.relPath)}:${s.line}</code></span>
        ${parent ? `<span>属于 <a data-symbol="${parent.id}">${escapeHtml(parent.qualifiedName)}</a></span>` : ''}
        <span>引用 ${s.refCount || 0} 次（${refs.length} 个文件）</span>
      </div>
      ${lastChangeHtml}
      ${s.signature ? `<div class="signature">${escapeHtml(s.signature)}</div>` : ''}
      ${s.jsdoc ? `<div class="jsdoc">${escapeHtml(s.jsdoc)}</div>` : ''}
      ${heritage ? `<h4>继承 / 实现</h4><ul class="heritage-list">${heritage}</ul>` : ''}
      ${members ? `<h4>成员（${(s.members || []).length}）</h4><ul class="member-list">${members}</ul>` : ''}
      ${refsHtml ? `<h4>跨文件引用（前 ${refs.length}）</h4><ul class="ref-list">${refsHtml}</ul>` : ''}
      ${s.snippet ? `<h4>定义片段</h4><div class="signature">${escapeHtml(truncate(s.snippet, 800))}</div>` : ''}
      <div class="actions">
        <button class="primary-btn" id="explainBtn">让 Claude 解释这个</button>
        ${parent ? `<button class="ghost-btn" data-symbol="${parent.id}">查看父符号</button>` : ''}
      </div>
    </div>`;
  $$('a[data-symbol], button[data-symbol]', detail).forEach((el) =>
    el.addEventListener('click', () => selectCodeMapSymbol(el.dataset.symbol)),
  );
  const explainBtn = $('#explainBtn', detail);
  if (explainBtn) explainBtn.addEventListener('click', () => prefillExplainPrompt(s));
}

function prefillExplainPrompt(s) {
  const lines = [
    `请帮我解释 ${s.kind} \`${s.qualifiedName}\`（位于 ${s.relPath}:${s.line}）。`,
    '',
    '请覆盖以下几点：',
    '1. 它的职责与设计意图；',
    '2. 输入 / 输出 / 副作用；',
    '3. 与项目里其他模块的关系（被谁调用、调用了什么）；',
    '4. 如果存在风险或值得改进的地方，请指出。',
  ];
  if (s.signature) {
    lines.push('', '签名：', '```', s.signature, '```');
  }
  if (s.jsdoc) {
    lines.push('', '现有注释：', s.jsdoc);
  }
  $('#promptInput').value = lines.join('\n');
  switchView('chat');
  $('#promptInput').focus();
}

function prefillExplainPathPrompt(node) {
  const isDir = node.type === 'dir';
  const target = isDir ? `目录 \`${node.relPath || node.name || '/'}\`` : `文件 \`${node.relPath}\``;
  const lines = [
    `请帮我解释${target}。`,
    '',
    '请覆盖以下几点：',
    isDir
      ? '1. 该目录在项目中的角色与职责；\n2. 主要文件 / 子目录的分工；\n3. 与其他目录的依赖或边界；\n4. 如果有可优化或冗余的结构，请指出。'
      : '1. 这个文件的职责与设计意图；\n2. 主要导出 / 入口；\n3. 与项目中其他模块的关系（被谁依赖、依赖了什么）；\n4. 如果存在风险或值得改进的地方，请指出。',
  ];
  if (node.summary) {
    lines.push('', '现有摘要：', node.summary);
  }
  $('#promptInput').value = lines.join('\n');
  switchView('chat');
  $('#promptInput').focus();
}

// ===== Audit view =====
function renderAuditView() {
  const tl = $('#auditTimeline');
  if (!state.detail) {
    tl.innerHTML = '<div class="empty">选择一个会话查看审计</div>';
    $('#auditSummary').textContent = '';
    return;
  }
  const events = state.detail.events.filter((e) => {
    if (!state.auditFilter) return true;
    return JSON.stringify(e).toLowerCase().includes(state.auditFilter);
  });
  $('#auditSummary').textContent = `共 ${events.length} 条事件`;
  tl.innerHTML = events
    .map(
      (e) => `
      <div class="audit-row">
        <span class="ts">${fmtTime(e.ts)}</span>
        <span class="typ">${escapeHtml(e.type)}</span>
        <span class="body">${escapeHtml(summarizeEvent(e))}</span>
      </div>`,
    )
    .join('') || '<div class="empty">暂无事件</div>';
}
function summarizeEvent(e) {
  switch (e.type) {
    case 'turn:start':
      return `[${e.turnId}] ${truncate(e.prompt, 200)}`;
    case 'turn:end':
      return `[${e.turnId}] ${e.status}`;
    case 'turn:result':
      return `[${e.turnId}] ${e.subtype || ''} ${e.cost ? '$' + e.cost.toFixed(4) : ''}`;
    case 'turn:changes':
      return `[${e.turnId}] ${(e.files || []).length} 个文件变更`;
    case 'assistant:text':
      return truncate(e.text, 200);
    case 'tool:use':
      return `${e.tool} → ${e.decision} (${e.reason || ''})`;
    case 'tool:result':
      return truncate(e.content || '', 200);
    case 'approval:pending':
      return `${e.tool} 等待人工：${e.reason}`;
    case 'approval:resolved':
      return `${e.toolUseId} → ${e.decision}`;
    case 'policy:changed':
      return `策略切换为 ${e.policyId}`;
    default:
      return truncate(JSON.stringify(e), 240);
  }
}

// ===== Policy view =====
function renderPolicyView() {
  const v = $('#policyView');
  const activeId = state.detail?.session?.policyId;
  v.innerHTML = `
    <h2 style="margin:0 0 12px">授权策略</h2>
    <p class="muted">策略决定 Claude Code 工具调用的处理方式。当前会话使用：<strong>${escapeHtml(activeId || '—')}</strong></p>
    ${Object.values(state.policies)
      .map(
        (p) => `
        <div class="policy-card ${p.id === activeId ? 'active' : ''}">
          <h4>${escapeHtml(p.name)} <span class="muted" style="font-weight:normal;font-size:11px">[${escapeHtml(p.id)}]</span></h4>
          <div class="desc">${escapeHtml(p.description)}</div>
          <div class="muted" style="font-size:11px">CLI 权限模式：<code>${escapeHtml(p.permissionMode)}</code></div>
          <ul class="policy-rules">
            ${p.rules
              .map(
                (r) => `
                <li>
                  <span class="badge ${r.decision === 'auto' ? 'auto' : r.decision}">${r.decision}</span>
                  <span>${escapeHtml(r.match)}</span>
                  <span class="muted">— ${escapeHtml(r.reason)}</span>
                </li>`,
              )
              .join('')}
          </ul>
          ${p.id !== activeId && state.detail
            ? `<button class="ghost-btn" data-policy="${p.id}" style="margin-top:10px">应用到当前会话</button>`
            : ''}
        </div>`,
      )
      .join('')}
  `;
  $$('button[data-policy]', v).forEach((b) =>
    b.addEventListener('click', async () => {
      $('#policySelect').value = b.dataset.policy;
      await changePolicy();
      await loadDetail();
      renderAll();
    }),
  );
}

// ===== GitNexus tab =====
function bindGitNexusSubtabsOnce() {
  if (bindGitNexusSubtabsOnce._done) return;
  bindGitNexusSubtabsOnce._done = true;
  $$('#gitNexusSubtabs .tab-btn').forEach((b) =>
    b.addEventListener('click', () => switchGitNexusSubtab(b.dataset.gn)),
  );
}

async function enterGitNexusTab() {
  bindGitNexusSubtabsOnce();
  if (state.gitNexusAvailable == null) await loadGitNexusHealth();
  if (!state.gitNexusAvailable || !state.gitNexusAvailable.available) {
    renderGitNexusStatus();
    $('#gitNexusPane').innerHTML = '';
    return;
  }
  if (!state.gitNexusStatus) {
    await loadGitNexusStatus();
  } else {
    renderGitNexusStatus();
  }
  reloadGitNexusSubview(false);
}

async function loadGitNexusHealth() {
  try {
    state.gitNexusAvailable = await api('/api/gitnexus/health');
  } catch (e) {
    state.gitNexusAvailable = { available: false, error: e.message };
  }
  renderGitNexusStatus();
}

async function loadGitNexusStatus() {
  if (!state.activeSessionId) return;
  $('#gitNexusStatus').innerHTML = '<span class="muted">读取索引状态…</span>';
  try {
    state.gitNexusStatus = await api(`/api/sessions/${state.activeSessionId}/gitnexus/status`);
  } catch (e) {
    state.gitNexusStatus = { error: e.message };
  }
  renderGitNexusStatus();
}

async function triggerGitNexusAnalyze(force = false) {
  if (!state.activeSessionId || state.gitNexusAnalyzing) return;
  state.gitNexusAnalyzing = true;
  state.gitNexusLog = [];
  renderGitNexusStatus();
  try {
    await api(`/api/sessions/${state.activeSessionId}/gitnexus/analyze`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
  } catch (e) {
    state.gitNexusAnalyzing = false;
    state.gitNexusLog.push({ stream: 'stderr', line: '✗ ' + e.message });
    renderGitNexusStatus();
    renderGitNexusLog();
  }
}

function switchGitNexusSubtab(name) {
  state.gitNexusSubtab = name;
  $$('#gitNexusSubtabs .tab-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.gn === name),
  );
  reloadGitNexusSubview(false);
}

function reloadGitNexusSubview(force) {
  const sub = state.gitNexusSubtab;
  if (sub === 'callgraph') {
    if (force || !state.gitNexusCallGraph) loadGitNexusCallGraph();
    else renderGitNexusPane();
  } else if (sub === 'hierarchy') {
    if (force) { state.gitNexusHierarchy = null; state.gitNexusCallGraph = null; }
    loadGitNexusHierarchy();
  } else if (sub === 'processes') {
    if (force || !state.gitNexusProcesses) loadGitNexusProcesses();
    else renderGitNexusPane();
  } else if (sub === 'impact') {
    renderGitNexusPane();
  }
}

function renderGitNexusStatus() {
  const el = $('#gitNexusStatus');
  if (!el) return;
  const av = state.gitNexusAvailable;
  if (!av) {
    el.innerHTML = '<span class="muted">检测中…</span>';
    return;
  }
  if (!av.available) {
    el.innerHTML = `
      <div class="gn-row">
        <strong>GitNexus 不可用</strong>
        <span class="muted">${escapeHtml(av.error || '未安装')}</span>
      </div>
      <div class="muted" style="margin-top:6px">请确认本机可执行 <code>npx gitnexus@latest --version</code>。</div>`;
    return;
  }
  const st = state.gitNexusStatus;
  const summary = st && st.summary ? st.summary : {};
  const indexed = st && st.indexed;
  const parts = [];
  if (summary.files != null) parts.push(`文件 ${summary.files}`);
  if (summary.symbols != null) parts.push(`符号 ${summary.symbols}`);
  if (summary.nodes != null) parts.push(`节点 ${summary.nodes}`);
  if (summary.edges != null) parts.push(`边 ${summary.edges}`);
  if (summary.lastIndexed) parts.push(`最近索引 ${escapeHtml(summary.lastIndexed)}`);
  if (summary.indexedCommit) parts.push(`commit ${escapeHtml(summary.indexedCommit.slice(0, 7))}`);
  const stale = summary.stale ? '<span class="gn-pill warn">索引已过期</span>' : '';
  el.innerHTML = `
    <div class="gn-row">
      <strong>GitNexus v${escapeHtml(av.version || '?')}</strong>
      ${indexed ? '<span class="gn-pill ok">已索引</span>' : '<span class="gn-pill">未索引</span>'}
      ${stale}
      <span class="muted">${parts.join(' · ')}</span>
      <span class="gn-spacer"></span>
      <button class="ghost-btn" id="gnAnalyzeBtn"${state.gitNexusAnalyzing ? ' disabled' : ''}>${state.gitNexusAnalyzing ? '索引中…' : (indexed ? '重新索引' : '索引仓库')}</button>
      <button class="ghost-btn" id="gnAnalyzeForceBtn"${state.gitNexusAnalyzing ? ' disabled' : ''}>强制全量</button>
    </div>
    ${state.gitNexusLog.length ? '<pre class="gitnexus-log" id="gitNexusLog"></pre>' : ''}`;
  const a = $('#gnAnalyzeBtn'); if (a) a.addEventListener('click', () => triggerGitNexusAnalyze(false));
  const f = $('#gnAnalyzeForceBtn'); if (f) f.addEventListener('click', () => triggerGitNexusAnalyze(true));
  if (state.gitNexusLog.length) renderGitNexusLog();
}

function renderGitNexusLog() {
  const log = $('#gitNexusLog');
  if (!log) return;
  log.textContent = state.gitNexusLog.map((l) => (l.stream === 'stderr' ? '! ' : '  ') + l.line).join('\n');
  log.scrollTop = log.scrollHeight;
}

async function loadGitNexusCallGraph() {
  if (!state.activeSessionId) return;
  const pane = $('#gitNexusPane');
  pane.innerHTML = '<div class="muted" style="padding:14px">读取调用图（cypher）…</div>';
  try {
    const resp = await api(`/api/sessions/${state.activeSessionId}/gitnexus/tool`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'callgraph', args: { limit: 300 } }),
    });
    state.gitNexusCallGraph = resp.result;
  } catch (e) {
    pane.innerHTML = `<div class="muted" style="padding:14px">读取失败：${escapeHtml(e.message)}<br/>提示：可能未索引，请先点击上方「索引仓库」。</div>`;
    return;
  }
  state.gitNexusGraphSelectedId = null;
  renderGitNexusPane();
}

async function loadGitNexusProcesses() {
  if (!state.activeSessionId) return;
  const pane = $('#gitNexusPane');
  pane.innerHTML = '<div class="muted" style="padding:14px">读取执行流…</div>';
  try {
    const resp = await api(`/api/sessions/${state.activeSessionId}/gitnexus/tool`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'processes', args: { limit: 50 } }),
    });
    state.gitNexusProcesses = resp.result;
  } catch (e) {
    pane.innerHTML = `<div class="muted" style="padding:14px">读取失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  renderGitNexusPane();
}

async function runGitNexusImpact(symbol) {
  if (!state.activeSessionId || !symbol) return;
  state.gitNexusImpactSymbol = symbol;
  state.gitNexusImpact = { loading: true };
  renderGitNexusPane();
  try {
    const resp = await api(`/api/sessions/${state.activeSessionId}/gitnexus/tool`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'impact', symbol }),
    });
    state.gitNexusImpact = { result: resp.result };
  } catch (e) {
    state.gitNexusImpact = { error: e.message };
  }
  renderGitNexusPane();
}

function renderGitNexusPane() {
  const sub = state.gitNexusSubtab;
  if (sub === 'callgraph') return renderGitNexusCallGraph();
  if (sub === 'hierarchy') return renderGitNexusHierarchy();
  if (sub === 'processes') return renderGitNexusProcesses();
  if (sub === 'impact') return renderGitNexusImpact();
}

function renderGitNexusCallGraph() {
  const pane = $('#gitNexusPane');
  const g = state.gitNexusCallGraph;
  if (!g) return;
  if (!g.nodes || g.nodes.length === 0) {
    pane.innerHTML = '<div class="muted" style="padding:14px">调用图为空。如果仓库已索引，可能是该语言尚未支持函数调用解析。</div>';
    return;
  }
  pane.innerHTML = `
    <div class="gn-graph-grid">
      <div class="graph-pane">
        <div class="graph-info muted">节点 ${g.nodes.length} · 边 ${g.edges.length} · 来源：GitNexus cypher</div>
        <svg id="gitNexusGraphSvg" class="module-graph"></svg>
      </div>
      <div id="gitNexusGraphDetail" class="structure-detail">点击节点查看详情。</div>
    </div>`;
  const svg = $('#gitNexusGraphSvg');
  const detail = $('#gitNexusGraphDetail');

  // Filter by structureSearch
  const search = state.structureSearch || '';
  const matchSet = new Set();
  for (const n of g.nodes) {
    if (!search || n.name.toLowerCase().includes(search) || (n.file || '').toLowerCase().includes(search)) {
      matchSet.add(n.id);
    }
  }

  if (!g._laid) layoutForceDirected(g);
  const rect = svg.getBoundingClientRect();
  const pad = 30;
  const w = Math.max(rect.width - pad * 2, 200);
  const h = Math.max(rect.height - pad * 2, 200);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of g.nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const sx = w / Math.max(maxX - minX, 1);
  const sy = h / Math.max(maxY - minY, 1);
  const s = Math.min(sx, sy);
  for (const n of g.nodes) {
    n.px = pad + (n.x - minX) * s;
    n.py = pad + (n.y - minY) * s;
  }

  const selected = state.gitNexusGraphSelectedId;
  const neighbors = new Set();
  if (selected) {
    neighbors.add(selected);
    for (const e of g.edges) {
      if (e.from === selected) neighbors.add(e.to);
      if (e.to === selected) neighbors.add(e.from);
    }
  }

  const ns = 'http://www.w3.org/2000/svg';
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML = `<marker id="gn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker>`;
  svg.appendChild(defs);

  const viewport = document.createElementNS(ns, 'g');
  viewport.setAttribute('class', 'viewport');
  svg.appendChild(viewport);

  const edgeGroup = document.createElementNS(ns, 'g');
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  for (const e of g.edges) {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a || !b) continue;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', a.px); line.setAttribute('y1', a.py);
    line.setAttribute('x2', b.px); line.setAttribute('y2', b.py);
    line.setAttribute('marker-end', 'url(#gn-arrow)');
    let cls = 'edge';
    if (selected) {
      if (e.from === selected || e.to === selected) cls += ' highlight';
      else cls += ' dim';
    }
    line.setAttribute('class', cls);
    edgeGroup.appendChild(line);
  }
  viewport.appendChild(edgeGroup);

  for (const n of g.nodes) {
    const grp = document.createElementNS(ns, 'g');
    let cls = 'node';
    if (selected === n.id) cls += ' selected';
    if (selected && !neighbors.has(n.id)) cls += ' dim';
    if (search && !matchSet.has(n.id)) cls += ' dim';
    grp.setAttribute('class', cls);
    grp.setAttribute('transform', `translate(${n.px},${n.py})`);
    grp.style.cursor = 'pointer';
    const r = 4 + Math.min(n.outDeg + n.inDeg, 10);
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('r', r);
    grp.appendChild(c);
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', r + 4);
    t.setAttribute('y', 3);
    t.textContent = n.name;
    grp.appendChild(t);
    grp.addEventListener('click', () => {
      state.gitNexusGraphSelectedId = state.gitNexusGraphSelectedId === n.id ? null : n.id;
      renderGitNexusCallGraph();
    });
    viewport.appendChild(grp);
  }

  attachPanZoom(svg, viewport, g);

  if (selected) {
    const node = nodeById.get(selected);
    if (node) {
      const incoming = g.edges.filter((e) => e.to === selected).map((e) => e.from);
      const outgoing = g.edges.filter((e) => e.from === selected).map((e) => e.to);
      detail.innerHTML = `
        <h3 style="margin-top:0">${escapeHtml(node.name)}</h3>
        <div class="muted" style="font-family:var(--mono);font-size:11px;margin-bottom:10px">${escapeHtml(node.file || node.id)}</div>
        <div>入度 ${node.inDeg} · 出度 ${node.outDeg}</div>
        <h4 style="margin-top:14px;margin-bottom:6px">调用方（入 ${incoming.length}）</h4>
        <ul style="padding-left:18px;margin:0">
          ${incoming.length === 0 ? '<li class="muted">无</li>' : incoming.slice(0, 50).map((d) => `<li><code>${escapeHtml((nodeById.get(d) || {}).name || d)}</code></li>`).join('')}
        </ul>
        <h4 style="margin-top:14px;margin-bottom:6px">被调用（出 ${outgoing.length}）</h4>
        <ul style="padding-left:18px;margin:0">
          ${outgoing.length === 0 ? '<li class="muted">无</li>' : outgoing.slice(0, 50).map((d) => `<li><code>${escapeHtml((nodeById.get(d) || {}).name || d)}</code></li>`).join('')}
        </ul>
        <div class="actions" style="margin-top:14px">
          <button class="ghost-btn" id="gnUseImpact">在「影响分析」中查看</button>
        </div>`;
      const btn = $('#gnUseImpact');
      if (btn) btn.addEventListener('click', () => {
        switchGitNexusSubtab('impact');
        runGitNexusImpact(node.name);
      });
    }
  } else {
    detail.innerHTML = '<div class="muted">点击节点查看详情。也可在上方搜索框输入函数名/文件名过滤节点。</div>';
  }
}

// ===== Hierarchy (icicle) view =====

function buildHierarchyFromCallGraph(g) {
  const root = { name: '/', path: [], children: new Map(), leafCount: 0, fnCount: 0,
                 inDeg: 0, outDeg: 0, isLeaf: false, nodeIds: [] };
  const topOf = (file) => {
    if (!file) return '<unknown>';
    const norm = file.replace(/^\.?\/+/, '');
    const seg = norm.split(/[\\/]/).filter(Boolean);
    return seg[0] || '<unknown>';
  };
  const segmentsOf = (file) => {
    if (!file) return ['<unknown>'];
    const norm = file.replace(/^\.?\/+/, '');
    return norm.split(/[\\/]/).filter(Boolean);
  };

  for (const n of g.nodes) {
    const segs = segmentsOf(n.file);
    // path: [seg1, seg2, ..., filename, fnName]
    const path = segs.concat([n.name || '(anonymous)']);
    let cur = root;
    for (let depth = 0; depth < path.length; depth++) {
      const part = path[depth];
      let child = cur.children.get(part);
      if (!child) {
        child = { name: part, path: path.slice(0, depth + 1), children: new Map(),
                  leafCount: 0, fnCount: 0, inDeg: 0, outDeg: 0,
                  isLeaf: depth === path.length - 1, nodeIds: [], file: depth === path.length - 1 ? n.file : null };
        cur.children.set(part, child);
      }
      cur = child;
    }
    cur.nodeIds.push(n.id);
    cur.inDeg = (cur.inDeg || 0) + (n.inDeg || 0);
    cur.outDeg = (cur.outDeg || 0) + (n.outDeg || 0);
  }

  // Recursive rollup
  const rollup = (node) => {
    if (node.isLeaf) {
      node.leafCount = 1;
      node.fnCount = 1;
      return;
    }
    let lc = 0, fc = 0, ind = 0, outd = 0;
    for (const c of node.children.values()) {
      rollup(c);
      lc += c.leafCount;
      fc += c.fnCount;
      ind += c.inDeg;
      outd += c.outDeg;
    }
    node.leafCount = Math.max(lc, 1);
    node.fnCount = fc;
    node.inDeg = ind;
    node.outDeg = outd;
  };
  rollup(root);

  // Top-level lookup for cross-module edges
  const topByNodeId = new Map();
  for (const n of g.nodes) topByNodeId.set(n.id, topOf(n.file));

  const crossEdges = new Map(); // "A→B" -> { from, to, count }
  for (const e of g.edges) {
    const a = topByNodeId.get(e.from);
    const b = topByNodeId.get(e.to);
    if (!a || !b || a === b) continue;
    const key = a + '→' + b;
    const rec = crossEdges.get(key);
    if (rec) rec.count++;
    else crossEdges.set(key, { from: a, to: b, count: 1 });
  }

  return { root, crossEdges, topByNodeId };
}

async function loadGitNexusHierarchy() {
  if (!state.activeSessionId) return;
  const pane = $('#gitNexusPane');
  if (!state.gitNexusCallGraph) {
    pane.innerHTML = '<div class="muted" style="padding:14px">读取调用图（cypher）…</div>';
    try {
      const resp = await api(`/api/sessions/${state.activeSessionId}/gitnexus/tool`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'callgraph', args: { limit: 300 } }),
      });
      state.gitNexusCallGraph = resp.result;
    } catch (e) {
      pane.innerHTML = `<div class="muted" style="padding:14px">读取失败：${escapeHtml(e.message)}<br/>提示：可能未索引，请先点击上方「索引仓库」。</div>`;
      return;
    }
  }
  state.gitNexusHierarchy = buildHierarchyFromCallGraph(state.gitNexusCallGraph);
  state.gitNexusHierarchySelected = null;
  state.gitNexusHierarchyHover = null;
  renderGitNexusHierarchy();
}

function getHierarchyNodeAt(root, path) {
  let cur = root;
  for (const part of path) {
    if (!cur.children) return null;
    cur = cur.children.get(part);
    if (!cur) return null;
  }
  return cur;
}

function renderGitNexusHierarchy() {
  const pane = $('#gitNexusPane');
  const h = state.gitNexusHierarchy;
  const g = state.gitNexusCallGraph;
  if (!h || !g) return;
  if (!g.nodes || g.nodes.length === 0) {
    pane.innerHTML = '<div class="muted" style="padding:14px">调用图为空。如果仓库已索引，可能是该语言尚未支持函数调用解析。</div>';
    return;
  }

  const rootPath = state.gitNexusHierarchyRoot || [];
  const subRoot = getHierarchyNodeAt(h.root, rootPath) || h.root;
  const crumbHtml = (() => {
    const parts = [`<a href="#" class="gn-crumb" data-depth="0">/</a>`];
    rootPath.forEach((p, i) => {
      parts.push(`<span class="gn-crumb-sep">›</span><a href="#" class="gn-crumb" data-depth="${i + 1}">${escapeHtml(p)}</a>`);
    });
    return parts.join('');
  })();

  pane.innerHTML = `
    <div class="gn-graph-grid">
      <div class="graph-pane">
        <div class="gn-icicle-bar">
          <div class="breadcrumb">${crumbHtml}</div>
          <div class="muted" style="font-size:11px">节点 ${g.nodes.length} · 边 ${g.edges.length} · 跨模块依赖 ${h.crossEdges.size} 条 · 点击下钻 · hover 显示虚线依赖</div>
        </div>
        <svg id="gnHierarchySvg" class="gn-icicle module-graph"></svg>
      </div>
      <div id="gnHierarchyDetail" class="structure-detail">点击方块查看详情；点击非叶子块下钻。</div>
    </div>`;

  $$('#gitNexusPane .gn-crumb').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const d = parseInt(a.dataset.depth, 10) || 0;
    state.gitNexusHierarchyRoot = rootPath.slice(0, d);
    state.gitNexusHierarchySelected = null;
    state.gitNexusHierarchyHover = null;
    renderGitNexusHierarchy();
  }));

  const svg = $('#gnHierarchySvg');
  const rect = svg.getBoundingClientRect();
  const W = Math.max(rect.width, 400);
  const H = Math.max(rect.height, 300);

  // Compute layers from subRoot — children, grandchildren, etc.
  const search = (state.structureSearch || '').toLowerCase();
  const matchesNode = (node) => {
    if (!search) return true;
    if (node.isLeaf) {
      const name = (node.name || '').toLowerCase();
      const file = (node.file || '').toLowerCase();
      return name.includes(search) || file.includes(search);
    }
    for (const c of node.children.values()) if (matchesNode(c)) return true;
    return false;
  };

  const layers = []; // [[cells], [cells], ...]
  const layout = (node, x0, y0, h, depth) => {
    if (!node.children || node.children.size === 0) return;
    const total = Array.from(node.children.values()).reduce((s, c) => s + c.leafCount, 0) || 1;
    const layerW = Math.min(180, Math.max(80, (W - 20) / Math.max(maxDepth, 1)));
    let y = y0;
    const cells = layers[depth] || (layers[depth] = []);
    for (const c of node.children.values()) {
      const ch = (c.leafCount / total) * h;
      cells.push({ node: c, x: x0, y, w: layerW, h: ch, depth });
      layout(c, x0 + layerW, y, ch, depth + 1);
      y += ch;
    }
  };
  // Determine max depth from subRoot
  let maxDepth = 0;
  (function depth(n, d) { maxDepth = Math.max(maxDepth, d); if (n.children) for (const c of n.children.values()) depth(c, d + 1); })(subRoot, 0);
  maxDepth = Math.max(maxDepth, 1);
  layout(subRoot, 10, 10, H - 20, 0);

  const ns = 'http://www.w3.org/2000/svg';
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML = `
    <marker id="gn-arrow-dash" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
    </marker>`;
  svg.appendChild(defs);

  const selectedPathStr = state.gitNexusHierarchySelected;
  const hoverTop = state.gitNexusHierarchyHover;

  // Render cells
  const cellLayer = document.createElementNS(ns, 'g');
  cellLayer.setAttribute('class', 'cells');
  svg.appendChild(cellLayer);

  // Top-level cells (depth 0 under subRoot). Their absolute top-level name
  // is rootPath[0] (if drilled in) or each cell's own name (if at /).
  const absTopName = (cell) => rootPath.length > 0 ? rootPath[0] : cell.node.name;

  for (const cells of layers) {
    for (const cell of cells) {
      const { node, x, y, w, h: ch, depth } = cell;
      if (ch < 1) continue;
      const grp = document.createElementNS(ns, 'g');
      let cls = `cell depth-${depth}`;
      if (node.isLeaf) cls += ' leaf';
      const pathStr = node.path.join('/');
      if (selectedPathStr === pathStr) cls += ' selected';
      if (!matchesNode(node)) cls += ' dim';
      grp.setAttribute('class', cls);
      grp.setAttribute('transform', `translate(${x},${y})`);
      grp.dataset.path = pathStr;
      grp.dataset.top = absTopName(cell);

      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('width', Math.max(w - 2, 1));
      r.setAttribute('height', Math.max(ch - 2, 1));
      r.setAttribute('rx', 3);
      grp.appendChild(r);

      if (ch >= 14) {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('class', 'label');
        t.setAttribute('x', 6);
        t.setAttribute('y', Math.min(14, ch / 2 + 4));
        const label = node.isLeaf
          ? node.name
          : `${node.name} · ${node.fnCount}`;
        t.textContent = label.length > 28 ? label.slice(0, 27) + '…' : label;
        grp.appendChild(t);
      }

      grp.addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.gitNexusHierarchySelected = pathStr;
        if (!node.isLeaf && node.children.size > 0) {
          state.gitNexusHierarchyRoot = node.path.slice();
        }
        renderGitNexusHierarchy();
      });

      cellLayer.appendChild(grp);
    }
  }

  // Cross-module edge layer (top of cells)
  const xmodLayer = document.createElementNS(ns, 'g');
  xmodLayer.setAttribute('class', 'xmod');
  svg.appendChild(xmodLayer);

  function renderXmodEdges() {
    while (xmodLayer.firstChild) xmodLayer.removeChild(xmodLayer.firstChild);
    if (!hoverTopRef.value) return;
    // Only meaningful at top-level (rootPath empty). When drilled in, every
    // visible block belongs to rootPath[0], so cross-module = nothing visible.
    if (rootPath.length > 0) return;
    // Find depth-0 cells (top-level modules currently visible).
    const topCells = (layers[0] || []).filter((c) => matchesNode(c.node));
    const centerOf = (name) => {
      const c = topCells.find((tc) => tc.node.name === name);
      if (!c) return null;
      return { x: c.x + c.w / 2, y: c.y + c.h / 2, top: c.y, bottom: c.y + c.h };
    };
    for (const rec of h.crossEdges.values()) {
      if (rec.from !== hoverTopRef.value && rec.to !== hoverTopRef.value) continue;
      const a = centerOf(rec.from);
      const b = centerOf(rec.to);
      if (!a || !b) continue;
      const path = document.createElementNS(ns, 'path');
      const midX = (a.x + b.x) / 2 + 60;
      const d = `M ${a.x} ${a.y} Q ${midX} ${(a.y + b.y) / 2} ${b.x} ${b.y}`;
      path.setAttribute('d', d);
      path.setAttribute('class', 'x-mod-edge');
      path.setAttribute('marker-end', 'url(#gn-arrow-dash)');
      path.setAttribute('stroke-width', Math.min(1 + Math.log2(rec.count + 1), 4));
      xmodLayer.appendChild(path);
    }
  }
  const hoverTopRef = { value: hoverTop };
  $$('#gnHierarchySvg .cell').forEach((g) => {
    g.addEventListener('mouseenter', () => { hoverTopRef.value = g.dataset.top; renderXmodEdges(); });
    g.addEventListener('mouseleave', () => { hoverTopRef.value = null; renderXmodEdges(); });
  });
  renderXmodEdges();

  // Detail pane
  const detail = $('#gnHierarchyDetail');
  if (selectedPathStr) {
    const node = getHierarchyNodeAt(h.root, selectedPathStr.split('/'));
    if (node) {
      const incomingXmod = [];
      const outgoingXmod = [];
      if (!rootPath.length || node.path[0] === rootPath[0]) {
        const topName = node.path[0];
        for (const rec of h.crossEdges.values()) {
          if (rec.to === topName && rec.from !== topName) incomingXmod.push(rec);
          if (rec.from === topName && rec.to !== topName) outgoingXmod.push(rec);
        }
      }
      detail.innerHTML = `
        <h3 style="margin-top:0">${escapeHtml(node.name)}${node.isLeaf ? '' : ' /'}</h3>
        <div class="muted" style="font-family:var(--mono);font-size:11px;margin-bottom:10px">${escapeHtml(node.path.join('/'))}</div>
        <div>${node.isLeaf ? '函数节点' : `${node.fnCount} 个函数 · ${node.children.size} 个子项`}</div>
        <div style="margin-top:6px">入度合计 ${node.inDeg} · 出度合计 ${node.outDeg}</div>
        ${node.file ? `<div class="muted" style="margin-top:6px">来源：<code>${escapeHtml(node.file)}</code></div>` : ''}
        <h4 style="margin-top:14px;margin-bottom:6px">跨模块入边（${incomingXmod.length}）</h4>
        <ul style="padding-left:18px;margin:0">
          ${incomingXmod.length === 0 ? '<li class="muted">无</li>' : incomingXmod.slice(0, 30).map((r) => `<li><code>${escapeHtml(r.from)}</code> → ${r.count} 次</li>`).join('')}
        </ul>
        <h4 style="margin-top:14px;margin-bottom:6px">跨模块出边（${outgoingXmod.length}）</h4>
        <ul style="padding-left:18px;margin:0">
          ${outgoingXmod.length === 0 ? '<li class="muted">无</li>' : outgoingXmod.slice(0, 30).map((r) => `<li><code>${escapeHtml(r.to)}</code> ← ${r.count} 次</li>`).join('')}
        </ul>
        ${node.isLeaf ? `<div class="actions" style="margin-top:14px"><button class="ghost-btn" id="gnHierUseImpact">在「影响分析」中查看</button></div>` : ''}`;
      const btn = $('#gnHierUseImpact');
      if (btn) btn.addEventListener('click', () => {
        switchGitNexusSubtab('impact');
        runGitNexusImpact(node.name);
      });
    } else {
      detail.innerHTML = '<div class="muted">所选节点已失效。</div>';
    }
  } else {
    detail.innerHTML = '<div class="muted">点击方块查看详情；点击非叶子块下钻，顶部面包屑可回到上一层。<br/>hover 顶层方块查看跨模块依赖（橙色虚线）。</div>';
  }
}

function renderGitNexusProcesses() {
  const pane = $('#gitNexusPane');
  const data = state.gitNexusProcesses;
  if (!data) return;
  const rows = Array.isArray(data) ? data : (data && (data.rows || data.records || data.data)) || [];
  if (!rows.length) {
    pane.innerHTML = '<div class="muted" style="padding:14px">未发现执行流。某些语言/小型项目无法生成 process 节点。</div>';
    return;
  }
  const search = state.structureSearch || '';
  const filtered = rows.filter((r) => !search || (r.name || '').toLowerCase().includes(search));
  pane.innerHTML = `
    <ul class="gn-process-list">
      ${filtered.map((r) => `
        <li>
          <div class="gn-proc-name">${escapeHtml(r.name || r.id || '<process>')}</div>
          <div class="gn-proc-meta muted">${r.steps != null ? `步骤 ${r.steps}` : ''}${r.id ? ` · id ${escapeHtml(r.id)}` : ''}</div>
        </li>`).join('')}
    </ul>`;
}

function renderGitNexusImpact() {
  const pane = $('#gitNexusPane');
  const v = state.gitNexusImpact;
  pane.innerHTML = `
    <form class="gn-impact-form" id="gnImpactForm">
      <input id="gnImpactInput" placeholder="输入函数/符号名，如 sendPrompt" value="${escapeHtml(state.gitNexusImpactSymbol)}" />
      <button class="primary-btn" type="submit">分析</button>
    </form>
    <div class="gn-impact-result" id="gnImpactResult"></div>`;
  $('#gnImpactForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#gnImpactInput').value.trim();
    if (v) runGitNexusImpact(v);
  });
  const out = $('#gnImpactResult');
  if (!v) {
    out.innerHTML = '<div class="muted">输入符号名，查看其下游受影响的节点。</div>';
    return;
  }
  if (v.loading) {
    out.innerHTML = '<div class="muted">分析中…</div>';
    return;
  }
  if (v.error) {
    out.innerHTML = `<div class="muted">失败：${escapeHtml(v.error)}</div>`;
    return;
  }
  out.innerHTML = `<pre>${escapeHtml(typeof v.result === 'string' ? v.result : JSON.stringify(v.result, null, 2))}</pre>`;
}

// ===== Memory: deposit, review modal, view, suggest panel =====

async function loadMemory() {
  try {
    const wd = state.detail?.session?.workdir;
    const url = wd ? `/api/memory?workdir=${encodeURIComponent(wd)}` : '/api/memory';
    const resp = await api(url);
    state.memory = resp;
    if (state.view === 'memory') renderMemoryView();
  } catch (e) {
    console.warn('loadMemory failed', e);
  }
}

function renderMemoryView() {
  const v = $('#memoryView');
  const entries = state.memory?.entries || [];
  const habits = entries.filter((e) => e.kind === 'habit');
  const experiences = entries.filter((e) => e.kind === 'experience');
  v.innerHTML = `
    <div class="memory-toolbar">
      <h2 style="margin:0">记忆库</h2>
      <span class="muted">习惯 ${habits.length} 条 · 经验 ${experiences.length} 条</span>
      <span style="flex:1"></span>
      <div class="tab-group">
        <button data-mtab="habit" class="tab-btn ${state.memoryTab === 'habit' ? 'active' : ''}">习惯</button>
        <button data-mtab="experience" class="tab-btn ${state.memoryTab === 'experience' ? 'active' : ''}">经验</button>
      </div>
    </div>
    <div class="memory-body">
      ${state.memoryTab === 'habit' ? renderHabitList(habits) : renderExperienceList(experiences)}
    </div>`;
  $$('button[data-mtab]', v).forEach((b) =>
    b.addEventListener('click', () => {
      state.memoryTab = b.dataset.mtab;
      renderMemoryView();
    }),
  );
  wireMemoryRowActions();
}

function renderHabitList(habits) {
  if (habits.length === 0) return '<div class="empty">还没有习惯。完成一轮任务后点击"沉淀经验"把决策沉淀进来。</div>';
  return habits.map((h) => {
    const c = h.counts || {};
    return `
      <div class="memory-card ${h.frozen ? 'memory-frozen' : ''}" data-id="${h.id}">
        <div class="memory-head">
          <span class="badge ${h.scope}">${h.scope === 'workdir' ? '本工程' : '全局'}</span>
          <strong>${escapeHtml(h.tool)}</strong>
          <code class="muted">${escapeHtml(h.keySignature)}</code>
          <span class="muted">${c.approve || 0}✓ / ${c.reject || 0}✗</span>
          <span class="muted">${h.lastTs ? fmtDateTime(h.lastTs) : ''}</span>
          <span style="flex:1"></span>
          <button class="ghost-btn mem-freeze" data-id="${h.id}" data-frozen="${h.frozen}">${h.frozen ? '解冻' : '冻结'}</button>
          <button class="ghost-btn mem-edit" data-id="${h.id}">编辑</button>
          <button class="ghost-btn mem-delete" data-id="${h.id}">删除</button>
        </div>
        <pre class="memory-input">${escapeHtml(JSON.stringify(h.inputSample, null, 2))}</pre>
        ${h.lastNote ? `<div class="muted">最近备注：${escapeHtml(h.lastNote)}</div>` : ''}
      </div>`;
  }).join('');
}

function renderExperienceList(exps) {
  if (exps.length === 0) return '<div class="empty">还没有经验。沉淀时蒸馏会产出经验卡片。</div>';
  return exps.map((e) => {
    return `
      <div class="memory-card" data-id="${e.id}">
        <div class="memory-head">
          <span class="badge ${e.scope}">${e.scope === 'workdir' ? '本工程' : '全局'}</span>
          <strong>${escapeHtml(e.title)}</strong>
          <span style="flex:1"></span>
          <label class="memory-toggle"><input type="checkbox" class="mem-tog-inj" data-id="${e.id}" ${e.enabledForInjection !== false ? 'checked' : ''}/> 注入</label>
          <label class="memory-toggle"><input type="checkbox" class="mem-tog-dec" data-id="${e.id}" ${e.enabledForDecider !== false ? 'checked' : ''}/> 决策</label>
          <button class="ghost-btn mem-edit" data-id="${e.id}">编辑</button>
          <button class="ghost-btn mem-delete" data-id="${e.id}">删除</button>
        </div>
        <div class="memory-body-text">${escapeHtml(e.body)}</div>
        ${(e.tags && e.tags.length) ? `<div class="memory-tags">${e.tags.map((t) => `<span class="memory-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        ${(e.triggers?.keywords?.length || e.triggers?.pathGlobs?.length || e.triggers?.tools?.length)
          ? `<div class="muted memory-triggers">触发：${[
              ...(e.triggers.tools || []).map((t) => `tool=${t}`),
              ...(e.triggers.pathGlobs || []).map((p) => `path=${p}`),
              ...(e.triggers.keywords || []).map((k) => `kw=${k}`),
            ].map(escapeHtml).join(' · ')}</div>`
          : ''}
      </div>`;
  }).join('');
}

function wireMemoryRowActions() {
  $$('.mem-delete', $('#memoryView')).forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('删除该记忆？此操作不可撤销。')) return;
      await api(`/api/memory/${b.dataset.id}`, { method: 'DELETE' });
      await loadMemory();
    }),
  );
  $$('.mem-freeze', $('#memoryView')).forEach((b) =>
    b.addEventListener('click', async () => {
      const frozen = b.dataset.frozen !== 'true';
      await api(`/api/memory/${b.dataset.id}`, {
        method: 'PUT', body: JSON.stringify({ frozen }),
      });
      await loadMemory();
    }),
  );
  $$('.mem-edit', $('#memoryView')).forEach((b) =>
    b.addEventListener('click', () => openMemoryEditDialog(b.dataset.id)),
  );
  $$('.mem-tog-inj', $('#memoryView')).forEach((cb) =>
    cb.addEventListener('change', async () => {
      await api(`/api/memory/${cb.dataset.id}`, {
        method: 'PUT', body: JSON.stringify({ enabledForInjection: cb.checked }),
      });
    }),
  );
  $$('.mem-tog-dec', $('#memoryView')).forEach((cb) =>
    cb.addEventListener('change', async () => {
      await api(`/api/memory/${cb.dataset.id}`, {
        method: 'PUT', body: JSON.stringify({ enabledForDecider: cb.checked }),
      });
    }),
  );
}

function openMemoryEditDialog(id) {
  const entry = (state.memory?.entries || []).find((e) => e.id === id);
  if (!entry) return;
  if (entry.kind === 'habit') {
    const a = parseInt(prompt('approve 计数', String(entry.counts?.approve || 0)) ?? '');
    if (Number.isNaN(a)) return;
    const r = parseInt(prompt('reject 计数', String(entry.counts?.reject || 0)) ?? '');
    if (Number.isNaN(r)) return;
    api(`/api/memory/${id}`, {
      method: 'PUT', body: JSON.stringify({ counts: { approve: a, reject: r } }),
    }).then(() => loadMemory());
  } else {
    const title = prompt('标题', entry.title);
    if (title == null) return;
    const body = prompt('正文', entry.body);
    if (body == null) return;
    api(`/api/memory/${id}`, {
      method: 'PUT', body: JSON.stringify({ title, body }),
    }).then(() => loadMemory());
  }
}

// ----- Deposit / review modal -----

async function openDepositDialog(turnId, { keepOpen = false } = {}) {
  if (!state.activeSessionId) return;
  state.depositDraft = null;
  state.depositSelected = null;
  const dialog = $('#depositDialog');
  if (!keepOpen) {
    $('#depositGuidance').value = '';
    if (!dialog.open) dialog.showModal();
  }
  const guidance = $('#depositGuidance').value.trim();
  $('#depositDialogContent').innerHTML = '<div class="muted">正在提取候选记忆 + 蒸馏经验（最多 60 秒）…</div>';
  $('#depositCommit').disabled = true;
  $('#depositRedistill').disabled = true;
  try {
    const resp = await api(`/api/sessions/${state.activeSessionId}/turns/${turnId}/distill`, {
      method: 'POST',
      body: JSON.stringify({ scope: 'workdir', includeExperiences: true, guidance }),
    });
    state.depositDraft = { ...resp, turnId };
    state.depositSelected = {
      habits: new Set(resp.habits.map((_, i) => i)),
      experiences: new Set((resp.experiences || []).map((_, i) => i)),
    };
    renderDepositDialog();
  } catch (e) {
    $('#depositDialogContent').innerHTML = `<div class="empty">提取失败：${escapeHtml(e.message)}</div>`;
  } finally {
    $('#depositRedistill').disabled = false;
  }
}

function renderDepositDialog() {
  const draft = state.depositDraft;
  if (!draft) return;
  const habits = draft.habits || [];
  const exps = draft.experiences || [];
  const errBlock = draft.distillError
    ? `<div class="deposit-error">经验蒸馏失败：${escapeHtml(draft.distillError)}（仍可保存习惯）</div>`
    : '';
  const habitRows = habits.length === 0
    ? '<div class="muted">本轮没有可提取的习惯（说明工具调用都被 policy 自动放行了）。</div>'
    : habits.map((h, i) => {
      const c = h.counts || {};
      return `
        <label class="deposit-row">
          <input type="checkbox" class="deposit-h-cb" data-i="${i}" ${state.depositSelected.habits.has(i) ? 'checked' : ''}/>
          <div class="deposit-row-body">
            <div><strong>${escapeHtml(h.tool)}</strong> <code>${escapeHtml(h.keySignature)}</code> ${c.approve || 0}✓/${c.reject || 0}✗</div>
            <pre class="deposit-input">${escapeHtml(JSON.stringify(h.inputSample, null, 2))}</pre>
          </div>
        </label>`;
    }).join('');
  const expRows = exps.length === 0
    ? '<div class="muted">蒸馏没有产出经验。</div>'
    : exps.map((e, i) => {
      return `
        <label class="deposit-row">
          <input type="checkbox" class="deposit-e-cb" data-i="${i}" ${state.depositSelected.experiences.has(i) ? 'checked' : ''}/>
          <div class="deposit-row-body">
            <div><strong contenteditable="true" data-edit-title="${i}">${escapeHtml(e.title)}</strong></div>
            <textarea class="deposit-edit-body" data-edit-body="${i}" rows="3">${escapeHtml(e.body)}</textarea>
            <div class="muted">tags: ${(e.tags || []).map(escapeHtml).join(', ')}</div>
          </div>
        </label>`;
    }).join('');
  $('#depositDialogContent').innerHTML = `
    ${errBlock}
    <div class="deposit-section">
      <h4>习惯候选（${habits.length}）</h4>
      ${habitRows}
    </div>
    <div class="deposit-section">
      <h4>经验候选（${exps.length}）</h4>
      ${expRows}
    </div>`;
  $$('.deposit-h-cb', $('#depositDialog')).forEach((cb) =>
    cb.addEventListener('change', () => {
      const i = parseInt(cb.dataset.i);
      if (cb.checked) state.depositSelected.habits.add(i);
      else state.depositSelected.habits.delete(i);
    }),
  );
  $$('.deposit-e-cb', $('#depositDialog')).forEach((cb) =>
    cb.addEventListener('change', () => {
      const i = parseInt(cb.dataset.i);
      if (cb.checked) state.depositSelected.experiences.add(i);
      else state.depositSelected.experiences.delete(i);
    }),
  );
  $('#depositCommit').disabled = false;
}

async function commitDepositSelection() {
  const draft = state.depositDraft;
  if (!draft) return;
  const habits = (draft.habits || []).filter((_, i) => state.depositSelected.habits.has(i));
  // Pull live edits from textareas / contenteditable.
  const exps = (draft.experiences || []).filter((_, i) => state.depositSelected.experiences.has(i))
    .map((e, idx) => {
      const trueIdx = (draft.experiences || []).indexOf(e);
      const titleEl = $(`[data-edit-title="${trueIdx}"]`, $('#depositDialog'));
      const bodyEl = $(`[data-edit-body="${trueIdx}"]`, $('#depositDialog'));
      return {
        ...e,
        title: titleEl ? titleEl.textContent : e.title,
        body: bodyEl ? bodyEl.value : e.body,
      };
    });
  if (habits.length === 0 && exps.length === 0) {
    $('#depositDialog').close();
    return;
  }
  try {
    const resp = await api('/api/memory/commit', {
      method: 'POST',
      body: JSON.stringify({ habits, experiences: exps }),
    });
    $('#depositDialog').close();
    alert(`已沉淀 ${(resp.created || 0) + (resp.updated || 0)} 条`);
    if (state.view === 'memory') loadMemory();
  } catch (e) {
    alert('沉淀失败：' + e.message);
  }
}

// ----- Suggest panel (relevant experiences for next prompt) -----

function scheduleSuggestRelevant() {
  if (state.suggestDebounce) clearTimeout(state.suggestDebounce);
  state.suggestDebounce = setTimeout(loadSuggestRelevant, 500);
}

async function loadSuggestRelevant() {
  if (!state.activeSessionId) return;
  const wd = state.detail?.session?.workdir;
  const txt = $('#promptInput')?.value?.trim() || '';
  if (!txt || !wd) {
    state.suggestRelevant = [];
    renderSuggestPanel();
    return;
  }
  try {
    const resp = await api(`/api/memory/relevant?workdir=${encodeURIComponent(wd)}&prompt=${encodeURIComponent(txt)}&sessionId=${encodeURIComponent(state.activeSessionId)}`);
    state.suggestRelevant = resp.items || [];
  } catch {
    state.suggestRelevant = [];
  }
  renderSuggestPanel();
}

function renderSuggestPanel() {
  let panel = $('#suggestPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'suggestPanel';
    panel.className = 'suggest-panel';
    const promptForm = $('#promptForm');
    if (promptForm) promptForm.parentNode.insertBefore(panel, promptForm);
  }
  if (!state.suggestRelevant || state.suggestRelevant.length === 0) {
    panel.innerHTML = '';
    return;
  }
  const n = state.suggestRelevant.length;
  const expanded = state.suggestExpanded;
  const cards = expanded
    ? state.suggestRelevant.map((e) => `
        <div class="suggest-card">
          <strong>${escapeHtml(e.title)}</strong>
          <div class="muted">${escapeHtml(truncate(e.body, 200))}</div>
        </div>`).join('')
    : '';
  panel.innerHTML = `
    <button type="button" class="suggest-head muted" id="suggestToggle"
      aria-expanded="${expanded}">
      <span class="suggest-chevron">${expanded ? '▾' : '▸'}</span>
      📚 相关经验 ${n} 条（发送时会注入到提示）
    </button>
    ${cards}`;
  const toggle = $('#suggestToggle');
  if (toggle) toggle.addEventListener('click', () => {
    state.suggestExpanded = !state.suggestExpanded;
    renderSuggestPanel();
  });
}

function insertDepositButtons() {
  const btn = $('#depositToolbarBtn');
  if (!btn) return;
  const pane = $('#chatPane');
  const legacy = pane?.querySelector('.chat-deposit-bar');
  if (legacy) legacy.remove();
  if (!state.detail) {
    btn.hidden = true;
    state.lastDepositTurnId = null;
    return;
  }
  const finishedTurns = state.detail.turns.filter((t) => t.status === 'done');
  if (finishedTurns.length === 0) {
    btn.hidden = true;
    state.lastDepositTurnId = null;
    return;
  }
  const last = finishedTurns[finishedTurns.length - 1];
  state.lastDepositTurnId = last.id;
  btn.hidden = false;
  btn.title = `沉淀第 ${last.id} 轮的工具决策与经验`;
}

// ===== Terminal (xterm.js + backend PTY via SSE) =====

// One xterm instance is reused across sessions; we just reattach to whichever
// session is active. Output flows in over SSE (`term:data`); keystrokes go
// out as POST /term/input. The backend keeps a small replay buffer so the
// screen is rehydrated on page refresh / session switch.

function ensureTerminal() {
  if (state.terminal?.term) return state.terminal;
  if (typeof Terminal === 'undefined') return null;
  const screen = $('#terminalScreen');
  if (!screen) return null;
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    cursorBlink: true,
    convertEol: true,
    theme: { background: '#0b0e14', foreground: '#d1d5db', cursor: '#93c5fd' },
  });
  const FitAddonCtor = window.FitAddon?.FitAddon;
  const fit = FitAddonCtor ? new FitAddonCtor() : null;
  if (fit) term.loadAddon(fit);
  term.open(screen);
  term.onData((data) => sendTerminalInput(data));
  term.onResize(({ cols, rows }) => sendTerminalResize(cols, rows));
  const ro = new ResizeObserver(() => {
    try { fit?.fit(); } catch {}
  });
  ro.observe(screen);
  state.terminal = { term, fit, attachedSessionId: null, resizeObserver: ro };
  return state.terminal;
}

async function attachTerminalToActiveSession() {
  const t = ensureTerminal();
  if (!t) return;
  const sessionId = state.activeSessionId;
  if (!sessionId) {
    t.term.reset();
    t.term.write('\x1b[90m请先选择一个会话\x1b[0m\r\n');
    t.attachedSessionId = null;
    return;
  }
  if (t.attachedSessionId === sessionId) return;
  try { t.fit?.fit(); } catch {}
  t.term.reset();
  const cols = t.term.cols || 80;
  const rows = t.term.rows || 24;
  try {
    const resp = await api(`/api/sessions/${sessionId}/term/attach`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    });
    if (state.activeSessionId !== sessionId) return; // user switched again mid-flight
    if (resp.replay) t.term.write(resp.replay);
    t.attachedSessionId = sessionId;
  } catch (e) {
    t.term.write(`\r\n\x1b[31m终端连接失败：${e.message}\x1b[0m\r\n`);
  }
}

let pendingInput = '';
let inputFlushTimer = null;

function sendTerminalInput(data) {
  if (!state.activeSessionId) return;
  pendingInput += data;
  if (inputFlushTimer) return;
  inputFlushTimer = setTimeout(flushTerminalInput, 8);
}

async function flushTerminalInput() {
  inputFlushTimer = null;
  const data = pendingInput;
  pendingInput = '';
  if (!data || !state.activeSessionId) return;
  try {
    await api(`/api/sessions/${state.activeSessionId}/term/input`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  } catch (e) {
    console.warn('term input failed', e);
  }
}

let resizeDebounce = null;
function sendTerminalResize(cols, rows) {
  if (!state.activeSessionId) return;
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(() => {
    api(`/api/sessions/${state.activeSessionId}/term/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    }).catch(() => {});
  }, 80);
}

async function restartTerminal() {
  if (!state.activeSessionId) return;
  try {
    await api(`/api/sessions/${state.activeSessionId}/term/kill`, { method: 'POST' });
  } catch {}
  if (state.terminal) state.terminal.attachedSessionId = null;
  attachTerminalToActiveSession();
}

function toggleTerminalFullscreen() {
  const panel = $('#terminalPanel');
  if (!panel) return;
  const next = !panel.classList.contains('fullscreen');
  panel.classList.toggle('fullscreen', next);
  const btn = $('#terminalFullscreenBtn');
  if (btn) btn.textContent = next ? '⛶ 退出全屏' : '⛶ 全屏';
  // Refit xterm after the layout change so cols/rows reflect the new size.
  // ResizeObserver also fires, but a direct fit avoids a one-frame mismatch.
  setTimeout(() => {
    try { state.terminal?.fit?.fit(); } catch {}
  }, 30);
}

function renderTerminal() {
  const cwdEl = $('#terminalCwd');
  const workdir = state.detail?.session?.workdir || '(未选择会话)';
  if (cwdEl) cwdEl.textContent = workdir;
  attachTerminalToActiveSession();
}

init().catch((err) => {
  console.error(err);
  alert('初始化失败：' + err.message);
});
