#!/usr/bin/env node
// caipira/hooks/turn-end.js — CodeWhale turn_end hook v3
//
// Two-phase memory capture:
//   Phase 1: Mechanical turn stats (always — fast, reliable)
//   Phase 2: Semantic turn content via session JSON delta-read + sidecar index
//
// Stdin:  {"event":"turn_end","status":"...","tool_count":...,"usage":{...},"session_id":"..."}

const { MemoryStore } = require('../store');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Config ──

const SESSIONS_DIR = path.join(os.homedir(), '.codewhale', 'sessions');
const INDEX_PATH = path.join(os.homedir(), '.caipira', 'session_index.json');
const MAX_USER_CHARS = 140;
const MAX_ASSISTANT_CHARS = 80;

// ── Prose compression (inline — same logic as caipira-compress.js) ──

function compressText(text) {
  let result = text;

  // Drop articles
  result = result.replace(/\bthe\b/gi, '');
  result = result.replace(/\ba\b/gi, '');
  result = result.replace(/\ban\b/gi, '');

  // Drop fillers
  const fillers = [
    'basically', 'actually', 'literally', 'quite', 'rather', 'very',
    'kind of', 'sort of', 'pretty much', 'in order to',
    'it should be noted that', 'as a matter of fact', 'please note that',
    'i think that', 'i believe that', 'it seems that', 'it appears that'
  ];
  for (const f of fillers) {
    result = result.replace(new RegExp('\\b' + f.replace(/\s+/g, '\\s+') + '\\b', 'gi'), '');
  }

  // Drop hedges
  const hedges = [
    'i would recommend', 'we should probably', 'it might be',
    'might want to', 'could potentially', 'may possibly',
    'i think', 'i believe', 'probably', 'maybe', 'perhaps'
  ];
  for (const h of hedges) {
    result = result.replace(new RegExp('\\b' + h.replace(/\s+/g, '\\s+') + '\\b', 'gi'), '');
  }

  // Drop pleasantries
  const pleasantries = ['please', 'thanks', 'thank you', 'sorry', 'sure', 'of course', 'no problem', 'happy to help'];
  for (const p of pleasantries) {
    result = result.replace(new RegExp('\\b' + p.replace(/\s+/g, '\\s+') + '\\b', 'gi'), '');
  }

  // Prose abbreviations — real compression, not just truncation
  const abbrevs = [
    ['database', 'DB'], ['configuration', 'cfg'], ['implementation', 'impl'],
    ['documentation', 'docs'], ['repository', 'repo'], ['application', 'app'],
    ['environment', 'env'], ['dependency', 'dep'], ['directory', 'dir'],
    ['parameter', 'param'], ['arguments', 'args'], ['function', 'fn'],
    ['variable', 'var'], ['reference', 'ref'], ['authentication', 'auth'],
    ['message', 'msg'], ['transaction', 'tx'], ['response', 'resp'],
    ['request', 'req'], ['asynchronous', 'async'], ['synchronous', 'sync'],
    ['because', 'b/c'], ['with', 'w/'], ['without', 'w/o'],
    ['should', 'shld'], ['would', 'wld'], ['could', 'cld'],
    ['between', 'btwn'], ['through', 'thru'], ['and', '&'], ['before', 'b4'],
    ['your', 'ur'], ['you', 'u'], ['are', 'r'],
  ];
  for (const [long, short] of abbrevs) {
    result = result.replace(new RegExp('\\b' + long + '\\b', 'gi'), short);
  }

  // Collapse whitespace
  result = result.replace(/\s{2,}/g, ' ').trim();
  return result;
}

// Strip caipira mode prefix injected by caipira-compress.js
function stripModePrefix(text) {
  return text.replace(/^\[caipira:[^\]]+\]\s*\n?/i, '').trim();
}

// ── Sidecar index ──

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_PATH)) {
      return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    }
  } catch (_) { /* corrupt → rebuild */ }
  return {};
}

function saveIndex(idx) {
  const dir = path.dirname(INDEX_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2), 'utf8');
}

// ── Session file discovery ──

function findMostRecentSession() {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const full = path.join(SESSIONS_DIR, f);
      try {
        return { path: full, mtime: fs.statSync(full).mtimeMs, name: f };
      } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] || null;
}

// ── Message extraction ──

function extractTextContent(message) {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(c => c.type === 'text')
    .map(c => c.text || '')
    .join(' ')
    .trim();
}

function extractTurnMessages(messages, lastProcessedCount) {
  const turns = [];
  let i = lastProcessedCount;

  while (i < messages.length - 1) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const userText = extractTextContent(msg);
      if (userText && i + 1 < messages.length && messages[i + 1].role === 'assistant') {
        const assistantText = extractTextContent(messages[i + 1]);
        if (assistantText) {
          turns.push({
            user: userText.slice(0, MAX_USER_CHARS),
            assistant: assistantText.slice(0, MAX_ASSISTANT_CHARS),
            messageIndex: i
          });
        }
      }
    }
    i++;
  }
  return turns;
}

function formatTurnObservation(turn, sessionId, turnIndex) {
  const cleanUser = stripModePrefix(turn.user);
  const cleanAssistant = stripModePrefix(turn.assistant);
  const compressedUser = compressText(cleanUser);
  const compressedAssistant = compressText(cleanAssistant);

  const userPreview = compressedUser.length > MAX_USER_CHARS
    ? compressedUser.slice(0, MAX_USER_CHARS - 1) + '\u2026'
    : compressedUser;
  const assistantPreview = compressedAssistant.length > MAX_ASSISTANT_CHARS
    ? compressedAssistant.slice(0, MAX_ASSISTANT_CHARS - 1) + '\u2026'
    : compressedAssistant;

  const topic = userPreview.split('\n')[0].trim();

  return {
    content: `User: ${userPreview} | Assistant: ${assistantPreview} | Topic: ${topic}`,
    metadata: {
      session_id: sessionId,
      turn_order: turnIndex,
      message_index: turn.messageIndex,
      user_len: turn.user.length,
      assistant_len: turn.assistant.length
    }
  };
}

// ── Mechanical summary builder ──

function buildMechanicalSummary(payload) {
  const parts = [];

  if (payload.error) {
    parts.push(`Turn error: ${String(payload.error).slice(0, 200)}`);
    return parts.join(' | ');
  }

  if (payload.tool_count > 0) {
    parts.push(`${payload.tool_count} tools`);
  }

  if (payload.usage) {
    const inK = Math.round((payload.usage.input_tokens || 0) / 1000);
    const outK = Math.round((payload.usage.output_tokens || 0) / 1000);
    if (inK > 0) parts.push(`${inK}k\u2192${outK}k tokens`);
  }

  const status = payload.status || 'ok';
  if (status !== 'ok' && status !== 'completed') {
    parts.push(`status=${status}`);
  }

  return parts.length > 0 ? parts.join(' | ') : null;
}

// ── Payload processor ──

function processPayload(chunks) {
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { process.stdout.write(JSON.stringify({})); return; }

  const hookSessionId = payload.session_id;
  if (!hookSessionId) { process.stdout.write(JSON.stringify({})); return; }

  try {
    const store = new MemoryStore();

    // ═════════════════════════════════════════════════════
    // Phase 1: Mechanical turn stats (always)
    // ═════════════════════════════════════════════════════

    const summary = buildMechanicalSummary(payload);
    if (summary) {
      store.addObservation({
        session_id: hookSessionId,
        kind: 'turn_end',
        content: summary,
        metadata: {
          status: payload.status,
          tool_count: payload.tool_count,
          error: payload.error ? String(payload.error).slice(0, 200) : null,
          tokens_in: payload.usage?.input_tokens,
          tokens_out: payload.usage?.output_tokens
        }
      });

      store.addSummary({
        session_id: hookSessionId,
        scope: 'turn',
        content: summary
      });
    }

    // Tool error capture
    if (payload.tool_results) {
      for (const tr of payload.tool_results) {
        if (tr.error || (tr.response && tr.response.exitCode !== 0)) {
          store.addObservation({
            session_id: hookSessionId,
            kind: 'tool_error',
            content: `${tr.tool || 'unknown'}: ${String(tr.error || tr.response?.stderr || 'failed').slice(0, 500)}`,
            metadata: { tool: tr.tool, exitCode: tr.response?.exitCode }
          });
        }
      }
    }

    // ═════════════════════════════════════════════════════
    // Phase 2: Semantic turn content (delta-read from session JSON)
    // ═════════════════════════════════════════════════════

    const sessionFile = findMostRecentSession();
    if (!sessionFile) {
      store.close();
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const raw = fs.readFileSync(sessionFile.path, 'utf8');

    let metadata;
    try {
      const metaIdx = raw.indexOf('"metadata"');
      if (metaIdx >= 0) {
        let metaStr = '';
        let depth = 0, started = false;
        for (let i = metaIdx; i < raw.length; i++) {
          if (raw[i] === '{') { depth++; started = true; }
          else if (raw[i] === '}') { depth--; }
          if (started) metaStr += raw[i];
          if (started && depth === 0) break;
        }
        metadata = JSON.parse(metaStr);
      }
    } catch (_) { /* malformed JSON → skip semantic capture */ }

    if (!metadata || !metadata.id || typeof metadata.message_count !== 'number') {
      store.close();
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const sessionId = metadata.id;
    const currentCount = metadata.message_count;

    const index = loadIndex();
    const entry = index[sessionId] || { last_message_count: 0 };
    const lastCount = entry.last_message_count || 0;

    if (currentCount <= lastCount) {
      store.close();
      process.stdout.write(JSON.stringify({}));
      return;
    }

    let session;
    try {
      session = JSON.parse(raw);
    } catch (_) {
      store.close();
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const messages = session.messages || [];
    const turns = extractTurnMessages(messages, lastCount);

    let storedCount = 0;
    for (const turn of turns) {
      const obs = formatTurnObservation(turn, sessionId, entry.turn_count ? entry.turn_count + storedCount : storedCount);
      store.addObservation({
        session_id: hookSessionId,
        kind: 'turn_semantic',
        content: obs.content,
        metadata: obs.metadata
      });
      storedCount++;
    }

    index[sessionId] = {
      last_message_count: currentCount,
      last_updated_at: metadata.updated_at || new Date().toISOString(),
      turn_count: (entry.turn_count || 0) + storedCount,
      workspace: metadata.workspace || null
    };
    saveIndex(index);

    store.close();
  } catch (err) {
    // silently fail — don't block turn completion
  }

  process.stdout.write(JSON.stringify({}));
}

// ── Main ──

function main() {
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => processPayload(chunks));

  // If stdin was already closed before listener registered (race with
  // CodeWhale's CREATE_SUSPENDED + immediate pipe-close), fire immediately.
  if (process.stdin.readableEnded) {
    processPayload(chunks);
  }
}

main();
