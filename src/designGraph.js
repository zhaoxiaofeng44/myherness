// Generate "design-level" structure graphs for the workspace using
// open-source tools.
// - type=modules → JS/TS module dependency graph via `madge`
// Future hooks (type=classes, type=calls) can be added without UI changes.
import path from 'node:path';
import fs from 'node:fs';
import madge from 'madge';
import { summarizeFile } from './fileSummary.js';

const JS_EXTS = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'];

export async function buildDesignGraph(workdir, opts = {}) {
  const type = opts.type || 'modules';
  if (type === 'modules') return await buildModuleGraph(workdir, opts);
  return { type, language: 'unknown', nodes: [], edges: [], notes: ['不支持的图类型: ' + type] };
}

async function buildModuleGraph(workdir, opts) {
  const language = detectLanguage(workdir);
  const notes = [];
  if (!hasJsLikeFiles(workdir)) {
    notes.push('当前工作目录未发现 JavaScript / TypeScript 源文件，模块依赖图为空。');
    return { type: 'modules', language, nodes: [], edges: [], notes };
  }

  let result;
  try {
    result = await madge(workdir, {
      fileExtensions: JS_EXTS,
      includeNpm: false,
      detectiveOptions: {
        es6: { mixedImports: true },
      },
      excludeRegExp: [/node_modules/, /\.git\//, /\bdist\b/, /\bbuild\b/, /\bcoverage\b/],
    });
  } catch (e) {
    notes.push('madge 执行失败：' + e.message);
    return { type: 'modules', language, nodes: [], edges: [], notes };
  }

  const tree = result.obj();
  const warnings = result.warnings ? result.warnings() : { skipped: [] };
  if (warnings.skipped && warnings.skipped.length > 0) {
    notes.push(`跳过 ${warnings.skipped.length} 个无法解析的文件`);
  }

  const nodeMap = new Map();
  const edges = [];
  const ensureNode = (rel) => {
    if (!nodeMap.has(rel)) {
      const ext = path.extname(rel).slice(1);
      const summary = summarizeFile(path.join(workdir, rel), ext);
      nodeMap.set(rel, {
        id: rel,
        name: path.basename(rel),
        relPath: rel,
        ext,
        outDeg: 0,
        inDeg: 0,
        ...(summary ? { summary } : {}),
      });
    }
    return nodeMap.get(rel);
  };

  for (const [from, deps] of Object.entries(tree)) {
    const f = ensureNode(from);
    for (const to of deps) {
      const t = ensureNode(to);
      f.outDeg++;
      t.inDeg++;
      edges.push({ from, to });
    }
  }

  // Detect cycles (madge has dedicated API).
  let cycles = [];
  try {
    cycles = result.circular ? result.circular() : [];
  } catch {}

  return {
    type: 'modules',
    language,
    nodes: Array.from(nodeMap.values()),
    edges,
    cycles,
    notes,
    rootCount: tree ? Object.keys(tree).length : 0,
  };
}

function detectLanguage(workdir) {
  if (fs.existsSync(path.join(workdir, 'package.json'))) {
    if (anyFileWithExt(workdir, ['ts', 'tsx'])) return 'typescript';
    return 'javascript';
  }
  if (anyFileWithExt(workdir, ['py'])) return 'python';
  if (anyFileWithExt(workdir, ['go'])) return 'go';
  if (anyFileWithExt(workdir, ['rs'])) return 'rust';
  if (anyFileWithExt(workdir, ['java', 'kt'])) return 'jvm';
  if (anyFileWithExt(workdir, JS_EXTS)) return 'javascript';
  return 'unknown';
}

function hasJsLikeFiles(workdir) {
  return anyFileWithExt(workdir, JS_EXTS);
}

const SCAN_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  'venv',
  '.venv',
  '__pycache__',
]);

function anyFileWithExt(root, exts, depth = 0, maxDepth = 4) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (SCAN_IGNORE.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (e.isFile()) {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (exts.includes(ext)) return true;
    } else if (e.isDirectory() && depth < maxDepth) {
      if (anyFileWithExt(full, exts, depth + 1, maxDepth)) return true;
    }
  }
  return false;
}
