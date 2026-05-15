// Directory structure scanner. Builds a tree node graph for the workspace.
import fs from 'node:fs';
import path from 'node:path';
import { summarizeFile, summarizeReadme, summarizeDirHeuristic } from './fileSummary.js';

const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  '.DS_Store',
  '.next',
  '.nuxt',
  '.cache',
  'dist',
  'build',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.idea',
  '.vscode',
  '.turbo',
  '.parcel-cache',
]);

export function scanStructure(rootDir, opts = {}) {
  const maxDepth = opts.maxDepth ?? 6;
  const maxEntriesPerDir = opts.maxEntriesPerDir ?? 200;
  const ignore = new Set([...DEFAULT_IGNORE, ...(opts.ignore || [])]);

  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return { id: rootDir, name: path.basename(rootDir), type: 'dir', children: [], error: '目录不存在' };
  }

  function walk(dir, depth) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return [];
    }
    entries = entries.filter((e) => !ignore.has(e.name) && !e.name.startsWith('.'));
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    if (entries.length > maxEntriesPerDir) entries = entries.slice(0, maxEntriesPerDir);

    return entries.map((e) => {
      const full = path.join(dir, e.name);
      const rel = path.relative(rootDir, full);
      if (e.isDirectory()) {
        const node = {
          id: rel,
          name: e.name,
          type: 'dir',
          path: full,
          relPath: rel,
          children: [],
        };
        if (depth < maxDepth) node.children = walk(full, depth + 1);
        else node.truncated = true;
        const readme = summarizeReadme(full);
        const summary = readme || summarizeDirHeuristic(node.children);
        if (summary) node.summary = summary;
        return node;
      }
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {}
      const ext = path.extname(e.name).slice(1);
      const node = {
        id: rel,
        name: e.name,
        type: 'file',
        path: full,
        relPath: rel,
        size,
        ext,
      };
      const summary = summarizeFile(full, ext);
      if (summary) node.summary = summary;
      return node;
    });
  }

  const rootChildren = walk(rootDir, 1);
  const rootReadme = summarizeReadme(rootDir);
  const rootSummary = rootReadme || summarizeDirHeuristic(rootChildren);
  return {
    id: '',
    name: path.basename(rootDir),
    type: 'dir',
    path: rootDir,
    relPath: '',
    ...(rootSummary ? { summary: rootSummary } : {}),
    children: rootChildren,
  };
}

// Flatten tree into a list of file nodes for quick lookups.
export function flattenFiles(tree) {
  const out = [];
  function visit(node) {
    if (node.type === 'file') out.push(node);
    if (node.children) node.children.forEach(visit);
  }
  visit(tree);
  return out;
}

// Annotate a tree with per-node change info (relPath -> { turn, kind }).
export function annotateChanges(tree, changeMap) {
  function visit(node) {
    if (node.type === 'file') {
      const info = changeMap[node.relPath];
      if (info) node.lastChange = info;
    } else if (node.children) {
      node.children.forEach(visit);
      const childChanges = node.children.filter((c) => c.lastChange || c.changeCount).length;
      if (childChanges > 0) {
        node.changeCount = node.children.reduce(
          (acc, c) => acc + (c.changeCount || (c.lastChange ? 1 : 0)),
          0,
        );
      }
    }
  }
  visit(tree);
  return tree;
}
