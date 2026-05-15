// habitExtractor — turns the events of a single completed turn into a list
// of candidate `habit` entries. Pure function; the user reviews the output
// before anything is persisted.
import { keyFor, hashWorkdir, auqAnswerKey, redactInput } from './memoryEngine.js';

export function extractHabits({ session, turnId, scope = 'workdir' }) {
  if (!session || !turnId) return [];
  const events = Array.isArray(session.events) ? session.events : [];
  const tools = Array.isArray(session.tools) ? session.tools : [];
  const toolById = new Map(tools.map((t) => [t.id, t]));
  const workdirHash = scope === 'workdir' ? hashWorkdir(session.workdir) : null;

  // Walk events: accumulate decisions per turn. Resolved approvals + tool:use
  // entries with decision==='auto'/'reject' both count, but we focus on user-
  // resolved approvals (the strongest signal of preference).
  const turnEvents = events.filter((e) => e.turnId === turnId || (e.type === 'turn:end' && e.turnId === turnId));
  const candidates = new Map(); // keySignature → candidate

  for (const evt of turnEvents) {
    if (evt.type === 'approval:resolved') {
      const tool = toolById.get(evt.toolUseId);
      if (!tool) continue;
      if (tool.tool === 'AskUserQuestion') {
        // Special-case AUQ: emit one habit per (question, picked-label).
        emitAUQAnswers({ tool, evt, candidates, workdirHash, scope, turnId, session });
      } else {
        emitToolHabit({ tool, evt, candidates, workdirHash, scope, turnId, session });
      }
    }
  }

  return Array.from(candidates.values());
}

function emitToolHabit({ tool, evt, candidates, workdirHash, scope, turnId, session }) {
  const { keySignature, inputSample } = keyFor(tool.tool, tool.input, session.workdir);
  const decision = evt.decision === 'reject' ? 'reject' : 'approve';
  let cand = candidates.get(keySignature);
  if (!cand) {
    cand = {
      tool: tool.tool,
      keySignature,
      inputSample,
      scope,
      workdirHash,
      counts: { approve: 0, reject: 0 },
      lastDecision: decision,
      lastNote: evt.note || '',
      lastTs: evt.ts || Date.now(),
      sessions: [],
    };
    candidates.set(keySignature, cand);
  }
  cand.counts[decision] = (cand.counts[decision] || 0) + 1;
  cand.lastDecision = decision;
  if (evt.note) cand.lastNote = evt.note;
  cand.lastTs = evt.ts || cand.lastTs;
  cand.sessions.push({
    sessionId: session.id,
    turnId,
    ts: evt.ts || Date.now(),
    decision,
    policyId: session.policyId,
  });
}

function emitAUQAnswers({ tool, evt, candidates, workdirHash, scope, turnId, session }) {
  // The note is a free-form text we asked the UI to assemble. We try to also
  // parse a `auqAnswers` array if the client sent it; otherwise we emit a
  // single habit keyed on the question+note hash so at least the *question*
  // is remembered.
  const answers = Array.isArray(evt.auqAnswers) ? evt.auqAnswers : null;
  const questionsArr = Array.isArray(tool.input?.questions) ? tool.input.questions : [];
  const sources = answers || inferAUQAnswers(tool.input, evt.note);

  for (const ans of sources) {
    const question = ans.question || (questionsArr[ans.qIndex]?.question) || '';
    const picks = Array.isArray(ans.picked) ? ans.picked : [];
    if (!question || picks.length === 0) continue;
    for (const label of picks) {
      const keySignature = auqAnswerKey(question, label);
      let cand = candidates.get(keySignature);
      if (!cand) {
        cand = {
          tool: 'AskUserQuestion',
          keySignature,
          inputSample: redactInput({ question, picked: label }),
          scope,
          workdirHash,
          counts: { approve: 0, reject: 0 },
          lastDecision: 'approve',
          lastNote: evt.note || '',
          lastTs: evt.ts || Date.now(),
          sessions: [],
        };
        candidates.set(keySignature, cand);
      }
      cand.counts.approve = (cand.counts.approve || 0) + 1;
      cand.lastDecision = 'approve';
      cand.lastTs = evt.ts || cand.lastTs;
      cand.sessions.push({
        sessionId: session.id,
        turnId,
        ts: evt.ts || Date.now(),
        decision: 'approve',
        policyId: session.policyId,
      });
    }
  }
}

// Best-effort parse of the textified note the UI assembles in submitAskUserQuestion:
//   • <question text>
//     → <picked / picked> | <custom>
function inferAUQAnswers(input, note) {
  if (!note || typeof note !== 'string') return [];
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const out = [];
  const lines = note.split('\n');
  let curQ = null;
  for (const line of lines) {
    const m = line.match(/^•\s*(.+)$/);
    if (m) {
      curQ = m[1].trim();
      continue;
    }
    const a = line.match(/^\s*→\s*(.+)$/);
    if (a && curQ) {
      const arrowPart = a[1].split('|')[0].trim();
      const picked = arrowPart.split('/').map((s) => s.trim()).filter(Boolean);
      // Match against the actual options (so we only sediment chip picks, not free text).
      const realQ = questions.find((q) => (q.question || '').trim() === curQ);
      const validLabels = new Set((realQ?.options || []).map((o) => (o.label || '').trim()));
      const validPicks = picked.filter((p) => validLabels.has(p));
      if (validPicks.length > 0) {
        out.push({ question: curQ, picked: validPicks });
      }
      curQ = null;
    }
  }
  return out;
}
