// caipira/inject.js — the retrieval gate that runs on every user prompt.
//
// This is the cheap half of a two-stage design. It runs inside a hook, in the
// latency path of every prompt, so it cannot load an embedder or call a model.
// It does lexical recall plus trust, and errs hard toward silence; the agent
// re-ranks properly through search_facts when it decides it needs more.
//
// Precision matters more than recall here, and the costs are asymmetric: a
// missed fact costs the user a sentence of re-explanation, while a wrong one
// plants a premise the model then reasons from. So the gate returns nothing
// unless it is reasonably sure, and never returns a ranked-best-of-N.

const { FactStore, trustScore } = require('./facts');
const { compress, expand, termForms, buildOrMatch } = require('./compress');
const path = require('path');

// Injecting the top N of anything guarantees noise on an unrelated prompt.
// These gates are on absolute properties of the match, not on rank.
//
// Relevance and freshness are gated separately rather than multiplied into a
// single threshold. A stale fact that clearly bears on the prompt should still
// surface, flagged, because "this decision may be out of date, re-read this
// file" is more useful than silence. Only relevance decides whether a fact is
// about the prompt; trust decides how it is presented and ranked.
const MIN_COVERAGE = 0.4;   // share of the prompt's meaningful terms the fact contains
const MIN_TRUST = 0.25;     // excludes revoked/superseded; admits needs_review
const MAX_FACTS = 3;
const MAX_CHARS = 1200;
const MAX_CANDIDATES = 40;

const PROMPT_STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'whose', 'why', 'how',
  'this', 'that', 'these', 'those', 'there', 'their', 'theirs', 'them', 'they',
  'then', 'than', 'from', 'into', 'onto', 'upon', 'over', 'under', 'about', 'after',
  'during', 'have', 'has', 'had', 'having', 'been', 'being', 'were', 'was', 'are',
  'can', 'will', 'does', 'did', 'done', 'some', 'such', 'only', 'also', 'more',
  'most', 'other', 'each', 'every', 'both', 'all', 'any', 'for', 'not', 'but',
  'nor', 'yet', 'our', 'out', 'off', 'own', 'same', 'too'
]);

/** @typedef {{fact: object, coverage: number, trust: number, score: number, stale: string[]}} InjectionCandidate */

// Function words are poison here. Explicit search can afford to keep them
// (AND still requires the real terms to match); coverage cannot, because
// "a" and "to" appear in every fact ever written and would carry any prompt
// over the threshold on their own.
// Prompts are prose: terms arrive with trailing question marks and commas
// attached. Left in place, "cavemem?" is matched literally and never finds
// "cavemem". Internal punctuation is kept, so package.json and w/o survive.
function normalizeTerm(term) {
  return term
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '');
}

function isMeaningful(term) {
  if (PROMPT_STOPWORDS.has(term.toLowerCase())) return false;
  // A short domain term can still carry meaning after lexicon expansion:
  // db, fn, tx, and mw become full searchable words.
  if (expand(term).replace(/[^\p{L}\p{N}]/gu, '').length < 3) return false;
  // The compressor already knows the filler and article list — reuse it
  // rather than maintaining a second stopword list that can drift from it.
  // Compare on letters and digits: "and" compresses to "&", which is not
  // empty but carries no meaning to match on.
  return compress(term, { intensity: 'full' }).replace(/[^\p{L}\p{N}]/gu, '').length > 0;
}

/** @param {string} prompt @returns {string[][]} */
function termGroups(prompt) {
  return prompt
    .split(/\s+/)
    .map(normalizeTerm)
    .filter(Boolean)
    .filter(isMeaningful)
    .map(termForms)
    .filter(forms => forms.length > 0);
}

// Whole-word matching. Substring matching silently fires "me" inside "mode"
// and "semantic", which is how an unrelated prompt reaches the threshold.
function containsWord(haystack, form) {
  const escaped = form.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`, 'u').test(haystack);
  } catch {
    return false;
  }
}

// How much of what the user actually asked about does this fact talk about?
/** @param {string[][]} groups @param {string} haystack @returns {number} */
function coverageOf(groups, haystack) {
  if (groups.length === 0) return 0;
  let hit = 0;
  for (const forms of groups) {
    if (forms.some(form => containsWord(haystack, form))) hit++;
  }
  return hit / groups.length;
}

/** @param {object} db @param {string} prompt @param {{machine?: string}} [opts] @returns {InjectionCandidate[]} */
function selectFacts(db, prompt, opts = {}) {
  const machine = opts.machine || 'unknown';
  const groups = termGroups(prompt || '');
  if (groups.length === 0) return [];

  const match = buildOrMatch(groups);
  let rows;
  try {
    rows = db.prepare(`
      SELECT f.*, bm25(facts_fts, 10.0, 6.0, 1.0) AS bm25
      FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
      WHERE facts_fts MATCH ? AND f.state IN ('active','needs_review')
      ORDER BY bm25 ASC LIMIT ?
    `).all(match, MAX_CANDIDATES);
  } catch {
    return [];
  }
  if (rows.length === 0) return [];

  const store = new FactStore(db, { machine, root: opts.root });
  const scored = [];
  for (const fact of rows) {
    const haystack = `${fact.title}\n${fact.summary}\n${fact.body}`.toLowerCase();
    const coverage = coverageOf(groups, haystack);
    if (coverage < MIN_COVERAGE) continue;

    const evidence = store.checkEvidence(fact.id);
    const trust = trustScore(fact, evidence);
    if (trust < MIN_TRUST) continue;
    const score = coverage * trust;

    scored.push({ fact, coverage, trust, score, stale: evidence.changedPaths });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_FACTS);
}

// Only summaries are injected, never bodies: the summary is written to be
// self-contained, and the body is one search_facts call away when needed.
/** @param {InjectionCandidate[]} selected @returns {string|null} */
function renderInjection(selected) {
  if (selected.length === 0) return null;

  const lines = ['Caipira recalled these established facts for this workspace:'];
  let budget = MAX_CHARS;

  for (const { fact, stale } of selected) {
    let line = `- [${fact.kind}#${fact.id}] ${fact.summary}`;
    if ((fact.state === 'needs_review' || stale.length > 0) && stale.length) {
      // A stale fact is still worth injecting, but it must say so rather than
      // present itself as current.
      line += ` (NEEDS REVIEW — changed since recorded: ${stale.join(', ')})`;
    }
    if (line.length > budget) continue;
    budget -= line.length;
    lines.push(line);
  }

  if (lines.length === 1) return null;
  lines.push('These are settled answers, not hints. Act on them directly rather than re-reading files or re-running checks to reconfirm them; verify only what is marked NEEDS REVIEW. If one is contradicted by what you find, call update_fact instead of silently working around it.');
  return lines.join('\n');
}

/** @param {object} db @param {string} prompt @param {{machine?: string}} [opts] @returns {string|null} */
function buildPromptInjection(db, prompt, opts) {
  try {
    return renderInjection(selectFacts(db, prompt, opts));
  } catch {
    return null;
  }
}

// SessionStart has no prompt to match against, so it carries only the small
// set of standing facts, and only the ones still verified.
/** @param {object} db @param {{limit?: number}} [opts] @returns {string|null} */
function buildStandingInjection(db, opts = {}) {
  try {
    // Every kind belongs here, ordered by how much a fresh session needs it
    // first: where the work stands, then the traps, then the standing rules.
    // Excluding status and gotcha would drop precisely the facts that stop a
    // new session having the whole context explained to it again.
    const rows = db.prepare(`
      SELECT * FROM facts
      WHERE state IN ('active','needs_review')
      ORDER BY CASE kind
                 WHEN 'status' THEN 0 WHEN 'gotcha' THEN 1
                 WHEN 'constraint' THEN 2 WHEN 'preference' THEN 3 ELSE 4 END,
               updated_at DESC
      LIMIT ?
    `).all(opts.limit || 8);
    if (rows.length === 0) return null;

    const lines = ['Caipira standing facts for this workspace:'];
    for (const fact of rows) {
      const flag = fact.state === 'needs_review' ? ' (NEEDS REVIEW — evidence changed)' : '';
      lines.push(`- [${fact.kind}#${fact.id}] ${fact.summary}${flag}`);
    }
    lines.push('Act on these directly — do not re-derive anything they cover. Use search_facts for the full body or for facts not listed here, check_drift before trusting one whose files may have moved, and record_fact for anything settled this session that is not already here.');
    return lines.join('\n');
  } catch {
    return null;
  }
}

// Plain code-unit order, as SQLite's default BINARY collation sorts paths, so
// the map is byte-identical whatever locale the hook runs under.
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const symbolPlace = (a, b) => compareText(a.path, b.path) || a.start - b.start || compareText(a.qualified, b.qualified);

/**
 * Renders the workspace's public symbol map within `room` characters.
 *
 * Session start pays for the map once, so prompt turns never repeat it and
 * the conversation prefix stays cacheable. When the map outgrows its room,
 * what survives is what the agent most likely needs: the active subpath,
 * then the most depended-on symbols, then the shallowest files. Every kept
 * symbol outranks every omitted one, and the kept lines are printed in
 * (subpath, path, line) order so the same index always renders the same text.
 * @param {object} db Open workspace database.
 * @param {string} subpath Workspace-relative directory the session runs in, or ''.
 * @param {number} room Characters available for the whole block.
 * @returns {string|null} null when there are no public symbols or none fits.
 */
function selectWorkspaceSymbols(db, subpath, room) {
  const rows = db.prepare(`SELECT path, name, qualified_name, kind, start_line, end_line
    FROM ast_symbols WHERE is_public = 1`).all();
  if (rows.length === 0) return null;

  // Only resolved edges count: an unresolved target names a symbol without
  // saying which file it lives in. Calls, type uses and inheritance point at
  // a symbol; an import points at the whole file it loads.
  const symbolFanIn = new Map();
  for (const edge of db.prepare(`SELECT target_path, target_symbol, COUNT(*) AS n FROM ast_edges
    WHERE target_path IS NOT NULL AND edge_kind != 'imports' GROUP BY target_path, target_symbol`).all()) {
    symbolFanIn.set(`${edge.target_path}\0${edge.target_symbol}`, edge.n);
  }
  const fileFanIn = new Map(db.prepare(`SELECT target_path, COUNT(*) AS n FROM ast_edges
    WHERE target_path IS NOT NULL AND edge_kind = 'imports' GROUP BY target_path`).all()
    .map(edge => [edge.target_path, edge.n]));

  const symbols = rows.map(row => ({
    line: `- ${row.path}::${row.qualified_name} (${row.kind} L${row.start_line}-${row.end_line})`,
    path: row.path,
    start: row.start_line,
    qualified: row.qualified_name,
    local: subpath && (row.path === subpath || row.path.startsWith(`${subpath}/`)) ? 1 : 0,
    fanIn: (symbolFanIn.get(`${row.path}\0${row.qualified_name}`) || 0)
      + (row.name !== row.qualified_name ? symbolFanIn.get(`${row.path}\0${row.name}`) || 0 : 0)
      + (fileFanIn.get(row.path) || 0),
    depth: row.path.split('/').length - 1
  }));
  symbols.sort((a, b) => b.local - a.local || b.fanIn - a.fanIn || a.depth - b.depth || symbolPlace(a, b));

  const header = 'Workspace symbols:';
  const footer = omitted => `(... ${omitted} more public symbols omitted to fit budget; use workspace_symbols or inspect_symbol)`;
  const whole = symbols.reduce((length, symbol) => length + 1 + symbol.line.length, header.length);
  // No footer can be longer than the one omitting every symbol, so reserving
  // its length keeps the real footer inside the room.
  const limit = whole <= room ? room : room - 1 - footer(symbols.length).length;
  const kept = [];
  let used = header.length;
  for (const symbol of symbols) {
    if (used + 1 + symbol.line.length > limit) break;
    used += 1 + symbol.line.length;
    kept.push(symbol);
  }
  if (kept.length === 0) return null;

  kept.sort((a, b) => b.local - a.local || symbolPlace(a, b));
  const lines = [header, ...kept.map(symbol => symbol.line)];
  if (kept.length < symbols.length) lines.push(footer(symbols.length - kept.length));
  return lines.join('\n');
}

/**
 * Builds bounded recall. Without a prompt (session start) it carries standing
 * facts, recent session digests, and the public symbol map; with one it
 * carries only the facts the prompt recalls, or nothing.
 * @param {object} db Open workspace database.
 * @param {{root: string}} workspace Resolved workspace.
 * @param {{cwd?: string, budget?: number, prompt?: string, machine?: string}} [opts]
 *   budget defaults to 2400 characters and is capped at 64000.
 * @returns {string|null}
 */
function buildInjection(db, workspace, opts = {}) {
  try {
    const budget = Math.max(0, Math.min(64000, Number.isInteger(opts.budget) ? opts.budget : 2400));
    if (!budget) return null;
    const relative = workspace && workspace.root && opts.cwd
      ? path.relative(workspace.root, opts.cwd).split(path.sep).join('/') : '';
    const subpath = relative && relative !== '.' && !relative.startsWith('..') ? relative : '';
    let facts;
    if (opts.prompt) {
      facts = selectFacts(db, opts.prompt, { machine: opts.machine, root: workspace?.root })
        .map(row => ({ ...row.fact, score: row.score, stale: row.stale }));
      // A prompt turn carries what the prompt recalled or nothing: repeating
      // session context here would only break the cached prefix.
      if (facts.length === 0) return null;
    } else {
      facts = db.prepare(`SELECT *, 0 AS score FROM facts WHERE state IN ('active','needs_review')
        ORDER BY updated_at DESC LIMIT 40`).all();
    }
    const locality = new Set();
    if (subpath) {
      const prefix = `${subpath}/`;
      const absolute = path.join(workspace.root, prefix);
      for (const row of db.prepare(`SELECT fact_id, path FROM fact_evidence`).all()) {
        if (row.path.startsWith(absolute)) locality.add(row.fact_id);
      }
      for (const row of db.prepare(`SELECT fact_id, path FROM fact_symbol_evidence`).all()) {
        if (row.path.startsWith(prefix)) locality.add(row.fact_id);
      }
    }
    const kindWeight = { status: 0.5, gotcha: 0.4, constraint: 0.3, preference: 0.2, decision: 0.1 };
    facts.sort((a, b) => (b.score + (kindWeight[b.kind] || 0) + (locality.has(b.id) ? 0.25 : 0)) -
      (a.score + (kindWeight[a.kind] || 0) + (locality.has(a.id) ? 0.25 : 0)) || b.updated_at - a.updated_at);

    const blocks = [];
    let used = 0;
    const add = line => {
      const candidate = blocks.length ? `\n${line}` : line;
      if (used + candidate.length > budget) return false;
      blocks.push(line);
      used += candidate.length;
      return true;
    };
    if (facts.length) {
      add(opts.prompt ? 'Caipira recalled facts:' : 'Caipira standing facts for this workspace:');
      for (const fact of facts.slice(0, 8)) {
        const flag = fact.stale?.length
          ? ` (NEEDS REVIEW — changed since recorded: ${fact.stale.join(', ')})`
          : fact.state === 'needs_review' ? ' (NEEDS REVIEW)' : '';
        add(`- [${fact.kind}#${fact.id}] ${fact.summary}${flag}`);
      }
    }
    if (!opts.prompt) {
      const sessions = db.prepare(`SELECT summary FROM sessions WHERE summary IS NOT NULL AND trim(summary) != ''
        ORDER BY COALESCE(ended_at, started_at) DESC LIMIT 2`).all();
      if (sessions.length && add('Recent sessions:')) {
        for (const session of sessions) add(`- ${session.summary}`);
      }
      const symbols = selectWorkspaceSymbols(db, subpath, budget - used - (blocks.length ? 1 : 0));
      if (symbols) add(symbols);
    }
    return blocks.length ? blocks.join('\n') : null;
  } catch {
    return null;
  }
}

// Facts whose evidence files have moved. Unlike prompt injection this is not
// a relevance judgement and needs no threshold: the fingerprints already prove
// the ground truth changed, so the only question is whether the fact survived
// the change. Surfaced unconditionally, because a stale fact that keeps being
// injected is worse than one nobody recorded.
/** @param {object} db @param {{limit?: number}} [opts] @returns {string|null} */
function buildDriftNotice(db, opts = {}) {
  try {
    const rows = db.prepare(`
      SELECT f.id, f.kind, f.summary,
             (SELECT GROUP_CONCAT(path, '|') FROM fact_evidence WHERE fact_id = f.id) AS paths
      FROM facts f WHERE f.state = 'needs_review'
      ORDER BY f.updated_at DESC LIMIT ?
    `).all(opts.limit || 5);
    if (rows.length === 0) return null;

    const lines = ['Caipira facts whose evidence changed — resolve before relying on them:'];
    for (const row of rows) {
      const files = (row.paths || '').split('|').filter(Boolean).map(p => p.split(/[\\/]/).pop());
      lines.push(`- [${row.kind}#${row.id}] ${row.summary}${files.length ? ` (changed: ${[...new Set(files)].join(', ')})` : ''}`);
    }
    lines.push('For each: if it still holds, reaffirm it via update_fact; if the change made it wrong, update_fact with the correction, or revoke it and record_fact the replacement with supersedes.');
    return lines.join('\n');
  } catch {
    return null;
  }
}

module.exports = {
  buildPromptInjection, buildStandingInjection, buildInjection, buildDriftNotice, selectFacts, renderInjection,
  selectWorkspaceSymbols, coverageOf, termGroups, MIN_COVERAGE, MIN_TRUST, MAX_FACTS
};
