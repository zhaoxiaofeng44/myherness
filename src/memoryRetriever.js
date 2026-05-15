// memoryRetriever — finds experience memories relevant to a prompt or
// approval context. Pure function; takes the entries array, returns a
// scored, filtered list.
import path from 'node:path';

import { hashWorkdir, allExperiences, relevantHabits } from './memoryEngine.js';

const DEFAULT_LIMIT = 5;

// Find experiences that should be injected into a new prompt.
export function relevantForPrompt(entries, { workdir, prompt, modifiedPaths = [] } = {}) {
  const workdirHash = hashWorkdir(workdir);
  const candidates = allExperiences(entries, { workdirHash });
  const promptLower = String(prompt || '').toLowerCase();
  const scored = [];
  for (const e of candidates) {
    if (e.enabledForInjection === false) continue;
    let score = 0;
    const triggers = e.triggers || {};
    if (Array.isArray(triggers.keywords)) {
      for (const k of triggers.keywords) {
        if (k && promptLower.includes(String(k).toLowerCase())) score += 3;
      }
    }
    if (Array.isArray(triggers.pathGlobs) && modifiedPaths.length) {
      for (const g of triggers.pathGlobs) {
        if (modifiedPaths.some((p) => simpleGlobMatch(g, p))) score += 2;
      }
    }
    if (Array.isArray(e.tags) && e.tags.length) {
      // Soft boost for any tag overlap with prompt tokens.
      for (const t of e.tags) {
        if (t && promptLower.includes(String(t).toLowerCase())) score += 1;
      }
    }
    score *= e.weight || 1;
    if (score >= 2) scored.push({ entry: e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, DEFAULT_LIMIT).map((s) => s.entry);
}

// Find memories relevant to a specific tool-use decision (for the decider).
export function relevantForDecision(entries, { workdir, tool, input, prompt }) {
  const workdirHash = hashWorkdir(workdir);
  const habits = relevantHabits(entries, { workdirHash, tool }).slice(0, 5);
  const targetPaths = collectPaths(input);
  const exps = allExperiences(entries, { workdirHash })
    .filter((e) => e.enabledForDecider !== false)
    .map((e) => ({ entry: e, score: scoreExperienceForDecision(e, { tool, paths: targetPaths, prompt }) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.entry);
  return { habits, experiences: exps };
}

function scoreExperienceForDecision(e, { tool, paths, prompt }) {
  let score = 0;
  const triggers = e.triggers || {};
  if (Array.isArray(triggers.tools) && tool && triggers.tools.includes(tool)) score += 2;
  if (Array.isArray(triggers.pathGlobs) && paths.length) {
    for (const g of triggers.pathGlobs) {
      if (paths.some((p) => simpleGlobMatch(g, p))) score += 2;
    }
  }
  if (Array.isArray(triggers.keywords) && prompt) {
    const lower = String(prompt).toLowerCase();
    for (const k of triggers.keywords) {
      if (k && lower.includes(String(k).toLowerCase())) score += 1;
    }
  }
  return score * (e.weight || 1);
}

function collectPaths(input) {
  if (!input || typeof input !== 'object') return [];
  const out = [];
  for (const key of ['file_path', 'path', 'notebook_path', 'output_file']) {
    if (typeof input[key] === 'string') out.push(input[key]);
  }
  return out;
}

// Minimal glob matcher: supports `*` (segment wildcard) and `**` (any depth).
// We intentionally avoid pulling in a full glob lib — these patterns are
// user-typed in the memory UI and a small predictable matcher is fine.
export function simpleGlobMatch(pattern, target) {
  if (!pattern || !target) return false;
  // Normalize.
  const p = pattern.replace(/\\/g, '/');
  const t = target.replace(/\\/g, '/');
  // Fast literal substring: helpful when user types "src/foo".
  if (!/[*?]/.test(p)) return t.includes(p);
  // Convert to regex.
  const re = '^' + p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
    .replace(/\?/g, '[^/]') + '$';
  try {
    return new RegExp(re).test(t);
  } catch {
    return false;
  }
}
