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

const { FactStore } = require('./facts');
const { compress, expand, termForms, buildOrMatch } = require('./compress');

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

  const store = new FactStore(db, { machine });
  const scored = [];
  for (const fact of rows) {
    const haystack = `${fact.title}\n${fact.summary}\n${fact.body}`.toLowerCase();
    const coverage = coverageOf(groups, haystack);
    if (coverage < MIN_COVERAGE) continue;

    const evidence = store.checkEvidence(fact.id);
    const trust = require('./facts').trustScore(fact, evidence);
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
  buildPromptInjection, buildStandingInjection, buildDriftNotice, selectFacts, renderInjection,
  coverageOf, termGroups, MIN_COVERAGE, MIN_TRUST, MAX_FACTS
};
