// Symbol-level "code map" using the TypeScript Compiler API.
// Walks the workspace, parses JS/TS files, and produces a navigable
// knowledge graph: project → modules → files → symbols.
//
// Symbol kinds: class, function, method, interface, type, enum, variable, react-component
// Each symbol carries: location, signature snippet, JSDoc, heritage,
// references (best-effort text search across the project).
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { summarizeSourceText } from './fileSummary.js';

const SOURCE_EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'];
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt',
  '.cache', '.turbo', 'venv', '.venv', '__pycache__', '.parcel-cache',
]);
const MAX_FILE_BYTES = 500_000;
const MAX_FILES = 800;

export function buildCodeMap(workdir, opts = {}) {
  const files = collectSourceFiles(workdir);
  if (files.length === 0) {
    return {
      language: 'unknown',
      modules: [],
      symbols: [],
      stats: { files: 0, symbols: 0 },
      notes: ['没有发现 JS/TS 源文件'],
    };
  }

  const symbols = []; // flat list, each carries unique id
  const fileEntries = []; // per-file summary

  for (const abs of files) {
    const rel = path.relative(workdir, abs);
    let text;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
    const fileSymbols = [];
    const imports = [];
    const exports = [];

    visit(sf);

    function visit(node) {
      try {
        switch (node.kind) {
          case ts.SyntaxKind.ImportDeclaration: {
            const m = (node.moduleSpecifier && node.moduleSpecifier.text) || '';
            const named = [];
            if (node.importClause) {
              if (node.importClause.name) named.push(node.importClause.name.text);
              if (node.importClause.namedBindings) {
                if (ts.isNamespaceImport(node.importClause.namedBindings)) {
                  named.push('* as ' + node.importClause.namedBindings.name.text);
                } else if (ts.isNamedImports(node.importClause.namedBindings)) {
                  for (const el of node.importClause.namedBindings.elements) named.push(el.name.text);
                }
              }
            }
            imports.push({ module: m, names: named });
            break;
          }
          case ts.SyntaxKind.ExportDeclaration: {
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
              for (const el of node.exportClause.elements) exports.push(el.name.text);
            }
            break;
          }
          case ts.SyntaxKind.ExportAssignment: {
            exports.push('default');
            break;
          }
          case ts.SyntaxKind.ClassDeclaration: {
            const sym = makeSymbolFromNode(node, 'class', sf, rel, text);
            if (sym) {
              const heritage = [];
              if (node.heritageClauses) {
                for (const hc of node.heritageClauses) {
                  const kw = hc.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
                  for (const t of hc.types) heritage.push({ kind: kw, name: t.expression.getText(sf) });
                }
              }
              sym.heritage = heritage;
              const members = [];
              for (const m of node.members) {
                if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) {
                  const mname = ts.isConstructorDeclaration(m) ? 'constructor' : (m.name && m.name.getText(sf)) || '';
                  const child = makeSymbolFromNode(m, 'method', sf, rel, text, sym.name + '.' + mname);
                  if (child) {
                    child.parent = sym.id;
                    child.signature = getCalleeSignature(m, sf, text);
                    symbols.push(child);
                    fileSymbols.push(child);
                    members.push({ id: child.id, name: mname, kind: 'method' });
                  }
                } else if (ts.isPropertyDeclaration(m) && m.name) {
                  members.push({ id: null, name: m.name.getText(sf), kind: 'property' });
                }
              }
              sym.members = members;
              if (isExported(node)) sym.exported = true;
              symbols.push(sym);
              fileSymbols.push(sym);
            }
            break;
          }
          case ts.SyntaxKind.FunctionDeclaration: {
            const sym = makeSymbolFromNode(node, 'function', sf, rel, text);
            if (sym) {
              sym.signature = getCalleeSignature(node, sf, text);
              if (isExported(node)) sym.exported = true;
              symbols.push(sym);
              fileSymbols.push(sym);
            }
            break;
          }
          case ts.SyntaxKind.InterfaceDeclaration: {
            const sym = makeSymbolFromNode(node, 'interface', sf, rel, text);
            if (sym) {
              const heritage = [];
              if (node.heritageClauses) {
                for (const hc of node.heritageClauses) {
                  for (const t of hc.types) heritage.push({ kind: 'extends', name: t.expression.getText(sf) });
                }
              }
              sym.heritage = heritage;
              if (isExported(node)) sym.exported = true;
              symbols.push(sym);
              fileSymbols.push(sym);
            }
            break;
          }
          case ts.SyntaxKind.TypeAliasDeclaration: {
            const sym = makeSymbolFromNode(node, 'type', sf, rel, text);
            if (sym) {
              if (isExported(node)) sym.exported = true;
              symbols.push(sym);
              fileSymbols.push(sym);
            }
            break;
          }
          case ts.SyntaxKind.EnumDeclaration: {
            const sym = makeSymbolFromNode(node, 'enum', sf, rel, text);
            if (sym) {
              if (isExported(node)) sym.exported = true;
              symbols.push(sym);
              fileSymbols.push(sym);
            }
            break;
          }
          case ts.SyntaxKind.VariableStatement: {
            // Top-level only
            if (node.parent && node.parent.kind === ts.SyntaxKind.SourceFile) {
              for (const decl of node.declarationList.declarations) {
                if (!decl.name || !ts.isIdentifier(decl.name)) continue;
                const init = decl.initializer;
                let kind = 'variable';
                if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) kind = 'function';
                if (init && ts.isClassExpression(init)) kind = 'class';
                const sym = makeSymbolFromIdentifier(decl, kind, sf, rel, text, decl.name.text);
                if (sym) {
                  if (kind === 'function' && init) sym.signature = getCalleeSignature(init, sf, text);
                  if (isExported(node)) sym.exported = true;
                  symbols.push(sym);
                  fileSymbols.push(sym);
                }
              }
            }
            break;
          }
        }
      } catch {}
      ts.forEachChild(node, visit);
    }

    const fileExt = path.extname(rel).slice(1);
    const summary = summarizeSourceText(text.slice(0, 4096), fileExt);
    fileEntries.push({
      relPath: rel,
      symbolIds: fileSymbols.map((s) => s.id),
      imports,
      exports,
      lines: text.split('\n').length,
      ...(summary ? { summary } : {}),
    });
  }

  // Build "references" — text-search occurrences of each symbol name in other files.
  // Cheap heuristic but gives a useful "used by" view.
  buildReferences(symbols, workdir, files);

  // Modules: group files by top-level directory.
  const modules = groupModules(fileEntries);

  // Pick "key" symbols heuristically
  const keySymbols = symbols
    .filter((s) => s.exported || s.kind === 'class')
    .sort((a, b) => (b.refCount || 0) - (a.refCount || 0))
    .slice(0, 20)
    .map((s) => s.id);

  return {
    language: detectLanguage(files),
    modules,
    files: fileEntries,
    symbols,
    keySymbols,
    stats: {
      files: fileEntries.length,
      symbols: symbols.length,
      classes: symbols.filter((s) => s.kind === 'class').length,
      functions: symbols.filter((s) => s.kind === 'function').length,
      interfaces: symbols.filter((s) => s.kind === 'interface').length,
    },
    notes: [],
  };
}

function isExported(node) {
  return !!(
    node.modifiers && node.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

let _id = 0;
function nextSymbolId() {
  _id++;
  return 'sym_' + _id.toString(36);
}

function makeSymbolFromNode(node, kind, sf, relPath, text, qualName) {
  const name = (node.name && node.name.getText(sf)) || '<anonymous>';
  return makeSymbol(node, kind, sf, relPath, text, qualName || name, name);
}
function makeSymbolFromIdentifier(decl, kind, sf, relPath, text, name) {
  return makeSymbol(decl, kind, sf, relPath, text, name, name);
}
function makeSymbol(node, kind, sf, relPath, text, qualName, name) {
  if (!name) return null;
  const start = node.getStart(sf);
  const end = node.getEnd();
  const { line } = sf.getLineAndCharacterOfPosition(start);
  const jsdoc = readJsDoc(node, sf);
  const snippet = text.slice(start, Math.min(end, start + 800));
  return {
    id: nextSymbolId(),
    name,
    qualifiedName: qualName,
    kind,
    relPath,
    line: line + 1,
    snippet,
    jsdoc,
  };
}

function getCalleeSignature(node, sf, text) {
  // First line up to {
  const start = node.getStart(sf);
  const idx = text.indexOf('{', start);
  const end = idx === -1 ? Math.min(node.getEnd(), start + 200) : idx;
  return text.slice(start, end).trim();
}

function readJsDoc(node, sf) {
  const text = sf.getFullText();
  const range = ts.getLeadingCommentRanges(text, node.getFullStart()) || [];
  const docs = [];
  for (const r of range) {
    const c = text.slice(r.pos, r.end);
    if (c.startsWith('/**')) {
      docs.push(
        c.replace(/^\/\*\*|\*\/$/g, '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trimEnd()).join('\n').trim(),
      );
    } else if (c.startsWith('//')) {
      docs.push(c.replace(/^\/\/\s?/gm, '').trim());
    }
  }
  return docs.join('\n\n').trim();
}

function buildReferences(symbols, workdir, files) {
  const byName = new Map();
  for (const s of symbols) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  const fileTexts = files.map((f) => {
    try { return { rel: path.relative(workdir, f), text: fs.readFileSync(f, 'utf8') }; }
    catch { return null; }
  }).filter(Boolean);

  for (const [name, syms] of byName) {
    if (name.length < 3 || /^\d+$/.test(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'g');
    const refs = [];
    for (const ft of fileTexts) {
      const matches = ft.text.match(re);
      if (!matches) continue;
      const definingHere = syms.filter((s) => s.relPath === ft.rel).length;
      const uses = matches.length - definingHere;
      if (uses <= 0) continue;
      refs.push({ relPath: ft.rel, count: uses });
    }
    for (const s of syms) {
      s.references = refs.filter((r) => r.relPath !== s.relPath);
      s.refCount = s.references.reduce((acc, r) => acc + r.count, 0);
    }
  }
}

function groupModules(fileEntries) {
  const groups = new Map();
  for (const f of fileEntries) {
    const top = f.relPath.includes('/') ? f.relPath.split('/')[0] : '(root)';
    if (!groups.has(top)) groups.set(top, { name: top, files: [] });
    groups.get(top).files.push(f);
  }
  return Array.from(groups.values()).map((g) => ({
    name: g.name,
    files: g.files,
    fileCount: g.files.length,
    symbolCount: g.files.reduce((acc, f) => acc + f.symbolIds.length, 0),
  }));
}

function scriptKindFor(rel) {
  if (rel.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (rel.endsWith('.ts')) return ts.ScriptKind.TS;
  if (rel.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function detectLanguage(files) {
  const hasTs = files.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  return hasTs ? 'typescript' : 'javascript';
}

function collectSourceFiles(root) {
  const out = [];
  function walk(dir) {
    if (out.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) break;
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (SOURCE_EXTS.includes(ext)) out.push(full);
      }
    }
  }
  walk(root);
  return out;
}
