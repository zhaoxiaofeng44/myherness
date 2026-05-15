// Heuristic "what is this file/dir about" extractor.
// - Files: leading JSDoc / block comment / contiguous line comments → first paragraph.
// - Markdown: first non-heading paragraph.
// - Directories: README first paragraph if present, else a stat-based one-liner.
import fs from 'node:fs';
import path from 'node:path';

const HEAD_BYTES = 4096;
const SUMMARY_MAX_LEN = 280;

const SLASH_LANGS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'go', 'rs', 'java', 'kt', 'scala', 'swift',
  'c', 'cc', 'cpp', 'h', 'hpp',
  'php', 'dart', 'cs',
  'css', 'scss', 'less',
]);
const HASH_LANGS = new Set([
  'py', 'rb', 'sh', 'bash', 'zsh',
  'yml', 'yaml', 'toml', 'ini',
  'mk', 'cmake', 'r',
]);
const SUMMARIZABLE_EXTS = new Set([
  ...SLASH_LANGS, ...HASH_LANGS,
  'md', 'mdx', 'rst', 'txt',
  'html', 'vue', 'svelte',
]);

export function isSummarizable(ext) {
  return SUMMARIZABLE_EXTS.has((ext || '').toLowerCase());
}

export function readFileHead(absPath, bytes = HEAD_BYTES) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd) try { fs.closeSync(fd); } catch {}
  }
}

export function summarizeSourceText(text, ext) {
  if (!text) return '';
  ext = (ext || '').toLowerCase();
  if (ext === 'md' || ext === 'mdx' || ext === 'rst' || ext === 'txt') {
    return summarizeMarkdownLike(text);
  }
  const stripped = stripPreamble(text);
  const block = matchLeadingBlockComment(stripped);
  if (block) return clip(block);
  const line = matchLeadingLineComments(stripped, ext);
  if (line) return clip(line);
  return '';
}

function stripPreamble(text) {
  let s = text.replace(/^﻿/, '');
  if (s.startsWith('#!')) {
    const nl = s.indexOf('\n');
    s = nl === -1 ? '' : s.slice(nl + 1);
  }
  s = s.replace(/^[\s\r\n]+/, '');
  s = s.replace(/^['"]use [^'"]+['"];?\s*\n?/, '');
  return s;
}

function matchLeadingBlockComment(s) {
  const m = s.match(/^\/\*+([\s\S]*?)\*\//);
  if (!m) return '';
  const body = m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return body.split(/\n\s*\n/)[0].trim();
}

function matchLeadingLineComments(s, ext) {
  let marker;
  if (HASH_LANGS.has(ext)) marker = '#';
  else if (SLASH_LANGS.has(ext)) marker = '//';
  else return '';
  const lines = s.split('\n');
  const out = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith(marker)) {
      const stripped = t.slice(marker.length).replace(/^[ \t]/, '');
      out.push(stripped);
    } else if (out.length === 0 && t === '') {
      continue;
    } else {
      break;
    }
  }
  return out.join(' ').trim();
}

function summarizeMarkdownLike(text) {
  const lines = text.split('\n');
  const para = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (t === '' || t.startsWith('---')) {
      if (para.length) break;
      continue;
    }
    if (t.startsWith('#') || /^=+$/.test(t) || /^-+$/.test(t)) {
      if (para.length) break;
      continue;
    }
    para.push(t.replace(/^[*\->\s]+/, ''));
  }
  return clip(para.join(' '));
}

function clip(s) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  if (s.length > SUMMARY_MAX_LEN) s = s.slice(0, SUMMARY_MAX_LEN - 1) + '…';
  return s;
}

export function summarizeFile(absPath, ext) {
  if (!isSummarizable(ext)) return '';
  const head = readFileHead(absPath);
  return summarizeSourceText(head, ext);
}

export function summarizeReadme(dirAbs) {
  const candidates = ['README.md', 'README.MD', 'Readme.md', 'readme.md', 'README'];
  for (const name of candidates) {
    const p = path.join(dirAbs, name);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return summarizeMarkdownLike(readFileHead(p, 8192));
      }
    } catch {}
  }
  return '';
}

export function summarizeDirHeuristic(children) {
  if (!Array.isArray(children) || children.length === 0) return '';
  let dirCount = 0;
  let fileCount = 0;
  const extCounts = new Map();
  for (const c of children) {
    if (c.type === 'dir') dirCount++;
    else {
      fileCount++;
      const e = (c.ext || '').toLowerCase();
      if (e) extCounts.set(e, (extCounts.get(e) || 0) + 1);
    }
  }
  const topExts = [...extCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([e, n]) => `.${e}×${n}`);
  const parts = [];
  if (dirCount) parts.push(`${dirCount} 个子目录`);
  if (fileCount) parts.push(`${fileCount} 个文件`);
  if (topExts.length) parts.push(topExts.join('、'));
  return parts.join(' · ');
}
