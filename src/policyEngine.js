// Policy engine — decides how Claude tool requests should be handled.
// Each session carries a Policy. Policies map to Claude Code's --permission-mode
// AND to a set of finer-grained rules we evaluate ourselves on tool_use events
// for visualization and auditing.

export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'];

export const PRESET_POLICIES = {
  conservative: {
    id: 'conservative',
    name: '保守模式',
    description: '默认权限模式，所有工具调用都标记为需要人工确认',
    permissionMode: 'default',
    rules: [
      { match: 'tool:Bash', decision: 'manual', reason: '命令执行需要人工确认' },
      { match: 'tool:Write', decision: 'manual', reason: '写入新文件需要确认' },
      { match: 'tool:Edit', decision: 'manual', reason: '编辑文件需要确认' },
      { match: 'tool:*', decision: 'manual', reason: '默认人工确认' },
    ],
  },
  balanced: {
    id: 'balanced',
    name: '平衡模式（推荐）',
    description: '自动允许编辑当前项目内的文件，命令与跨目录操作转人工',
    permissionMode: 'acceptEdits',
    rules: [
      { match: 'path:outside-workdir', decision: 'manual', reason: '操作目标在工作目录之外' },
      { match: 'tool:Bash:rm', decision: 'manual', reason: '涉及删除命令' },
      { match: 'tool:Bash:git push', decision: 'manual', reason: '涉及推送远端仓库' },
      { match: 'tool:Bash:git reset --hard', decision: 'manual', reason: '可能丢失工作' },
      { match: 'tool:Bash', decision: 'auto', reason: '一般命令在工作目录内自动允许' },
      { match: 'tool:Edit', decision: 'auto', reason: '当前项目内编辑自动允许' },
      { match: 'tool:Write', decision: 'auto', reason: '当前项目内写入自动允许' },
      { match: 'tool:Read', decision: 'auto', reason: '只读操作自动允许' },
      { match: 'tool:Grep', decision: 'auto', reason: '搜索操作自动允许' },
      { match: 'tool:Glob', decision: 'auto', reason: '搜索操作自动允许' },
      { match: 'tool:*', decision: 'auto', reason: '默认自动允许（受 acceptEdits 模式约束）' },
    ],
  },
  aggressive: {
    id: 'aggressive',
    name: '激进模式',
    description: '跳过全部权限检查（仅在受信目录使用）',
    permissionMode: 'bypassPermissions',
    rules: [
      { match: 'tool:*', decision: 'auto', reason: '已开启 bypassPermissions，全部跳过' },
    ],
  },
  auto: {
    id: 'auto',
    name: '自动模式',
    description:
      '常规工具自动放行；当 Claude 调用 AskUserQuestion / ExitPlanMode 等需要你回答的工具时，弹出交互框等你输入，不会自动跳过',
    permissionMode: 'acceptEdits',
    rules: [
      { match: 'tool:AskUserQuestion', decision: 'manual', reason: '需要你回答 Claude 的提问' },
      { match: 'tool:ExitPlanMode', decision: 'manual', reason: '需要你确认计划' },
      { match: 'path:outside-workdir', decision: 'manual', reason: '操作目标在工作目录之外' },
      { match: 'tool:Bash:rm -rf', decision: 'manual', reason: '涉及递归删除' },
      { match: 'tool:Bash:git push --force', decision: 'manual', reason: '涉及强制推送' },
      { match: 'tool:*', decision: 'auto', reason: '自动放行' },
    ],
  },
  planOnly: {
    id: 'planOnly',
    name: '只计划',
    description: '只生成计划，不允许执行修改类工具',
    permissionMode: 'plan',
    rules: [
      { match: 'tool:Edit', decision: 'reject', reason: '当前为只计划模式' },
      { match: 'tool:Write', decision: 'reject', reason: '当前为只计划模式' },
      { match: 'tool:Bash', decision: 'reject', reason: '当前为只计划模式' },
      { match: 'tool:*', decision: 'auto', reason: '只读类操作允许' },
    ],
  },
};

export function getPolicy(id) {
  return PRESET_POLICIES[id] || PRESET_POLICIES.balanced;
}

// Tools that ALWAYS need a human in the loop, regardless of policy. These
// exist precisely to ask the user something, so auto-approving them defeats
// their purpose — Claude would proceed without ever seeing the answer.
// Hardcoded as a global override so no policy preset can accidentally bypass.
const ALWAYS_MANUAL_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Evaluate a tool_use event against a policy.
// Returns { decision: 'auto'|'manual'|'reject', reason, rule }
export function evaluateToolUse(policy, toolUse, ctx = {}) {
  const toolName = toolUse.name || toolUse.tool || 'Unknown';
  const input = toolUse.input || {};
  const workdir = ctx.workdir;

  if (ALWAYS_MANUAL_TOOLS.has(toolName)) {
    return {
      decision: 'manual',
      reason: toolName === 'AskUserQuestion'
        ? 'Claude 需要你回答问题（始终人工处理）'
        : '需要你确认计划（始终人工处理）',
      rule: { match: `tool:${toolName}`, decision: 'manual', reason: 'always-manual', builtin: true },
    };
  }

  for (const rule of policy.rules) {
    const m = rule.match;
    if (!m.startsWith('tool:') && !m.startsWith('path:')) continue;

    if (m === 'path:outside-workdir' && workdir) {
      const targets = collectPathTargets(input);
      const outside = targets.find((p) => !isInside(p, workdir));
      if (outside) {
        return { decision: rule.decision, reason: rule.reason + `（${outside}）`, rule };
      }
      continue;
    }

    if (m.startsWith('tool:')) {
      const parts = m.slice('tool:'.length).split(':');
      const ruleTool = parts[0];
      const subPattern = parts.slice(1).join(':');

      if (ruleTool !== '*' && ruleTool !== toolName) continue;

      if (subPattern) {
        // Try matching against bash command
        const cmd = input.command || input.cmd || '';
        if (!cmd.toLowerCase().includes(subPattern.toLowerCase())) continue;
      }
      return { decision: rule.decision, reason: rule.reason, rule };
    }
  }
  return { decision: 'manual', reason: '没有命中规则，转人工确认', rule: null };
}

function collectPathTargets(input) {
  const targets = [];
  for (const key of ['file_path', 'path', 'notebook_path', 'output_file']) {
    if (typeof input[key] === 'string') targets.push(input[key]);
  }
  return targets;
}

function isInside(target, workdir) {
  if (!target) return true;
  let abs = target;
  if (!abs.startsWith('/')) abs = workdir.replace(/\/$/, '') + '/' + abs;
  const wd = workdir.replace(/\/$/, '');
  // Tolerate macOS symlink prefix /tmp <-> /private/tmp
  const candidates = [wd];
  if (wd.startsWith('/private/')) candidates.push(wd.slice('/private'.length));
  else candidates.push('/private' + wd);
  return candidates.some((c) => abs === c || abs.startsWith(c + '/'));
}
