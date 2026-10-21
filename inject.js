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

const { FactStore, AstRefreshScope, trustScore, FACT_RANK_SQL, FACT_RANK_PARAMS } = require('./facts');
const { compress, expand, termForms, buildOrMatch } = require('./compress');
const fs = require('fs');
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

// buildInjection's character budgets. A prompt turn (and any caller that
// names no budget) gets the small one; session start pays for the symbol map
// once, so it gets a larger one; no caller may exceed the cap.
const PROMPT_BUDGET_CHARS = 2400;
const STARTUP_BUDGET_CHARS = 24000;
const MAX_BUDGET_CHARS = 64000;

// Session start ranks this many of the most recently updated facts and shows
// at most MAX_STANDING_FACTS of them; buildStandingInjection shows as many.
const STANDING_CANDIDATES = 40;
const MAX_STANDING_FACTS = 8;
const RECENT_SESSION_DIGESTS = 2;
const DRIFT_NOTICE_LIMIT = 5;

// Ranking bonuses added to a fact's prompt score: where the work stands
// first, then the traps, then the standing rules; and a fact whose evidence
// lies under the session's subdirectory over one from elsewhere.
const KIND_WEIGHT = { status: 0.5, gotcha: 0.4, constraint: 0.3, preference: 0.2, decision: 0.1 };
const LOCALITY_BONUS = 0.25;

const PROMPT_STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'whose', 'why', 'how',
  'this', 'that', 'these', 'those', 'there', 'their', 'theirs', 'them', 'they',
  'then', 'than', 'from', 'into', 'onto', 'upon', 'over', 'under', 'about', 'after',
  'during', 'have', 'has', 'had', 'having', 'been', 'being', 'were', 'was', 'are',
  'can', 'will', 'does', 'did', 'done', 'some', 'such', 'only', 'also', 'more',
  'most', 'other', 'each', 'every', 'both', 'all', 'any', 'for', 'not', 'but',
  'nor', 'yet', 'our', 'out', 'off', 'own', 'same', 'too'
]);

/**
 * @typedef {{fact: object, coverage: number, trust: number, score: number, stale: string[], unchecked: boolean}} InjectionCandidate
 * `unchecked` is true when some of the fact's symbol evidence could not be re-checked.
 */

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

/**
 * The facts a prompt recalls, best first, or none.
 * @param {object} db Open workspace database.
 * @param {string} prompt
 * @param {{machine?: string, root?: string, astScope?: AstRefreshScope}} [opts] astScope bounds and
 *   shares the parser refreshes evidence checks need; a fresh unbounded scope when omitted.
 * @returns {InjectionCandidate[]} Empty when nothing clears the gates.
 * @throws {Error} When the fact store cannot be read; a miss is an empty list, never an error.
 */
function selectFacts(db, prompt, opts = {}) {
  const machine = opts.machine || 'unknown';
  const groups = termGroups(prompt || '');
  if (groups.length === 0) return [];

  const match = buildOrMatch(groups);
  const rows = db.prepare(`
    SELECT f.*, ${FACT_RANK_SQL} AS bm25
    FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
    WHERE facts_fts MATCH ? AND f.state IN ('active','needs_review')
    ORDER BY bm25 ASC LIMIT ?
  `).all(...FACT_RANK_PARAMS, match, MAX_CANDIDATES);
  if (rows.length === 0) return [];

  const store = new FactStore(db, { machine, root: opts.root });
  const scope = opts.astScope || new AstRefreshScope();
  const scored = [];
  for (const fact of rows) {
    const haystack = `${fact.title}\n${fact.summary}\n${fact.body}`.toLowerCase();
    const coverage = coverageOf(groups, haystack);
    if (coverage < MIN_COVERAGE) continue;

    const evidence = store.checkEvidence(fact.id, scope);
    const trust = trustScore(fact, evidence);
    if (trust < MIN_TRUST) continue;
    const score = coverage * trust;

    scored.push({ fact, coverage, trust, score, stale: evidence.changedPaths, unchecked: evidence.unchecked > 0 });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_FACTS);
}

/**
 * @callback RecallFailureHandler
 * @param {string} operation The recall block that failed, e.g. 'workspace symbols'.
 * @param {Error} error The underlying failure.
 * @returns {void}
 */

// Recall is optional context, so a failure must never cost the caller its
// turn, but it must not pass for a relevance miss either: it is reported once
// to whoever owns the boundary, or to stderr when nobody claimed it.
/** @param {RecallFailureHandler|undefined} onFailure @param {string} operation @param {Error} error */
function reportFailure(onFailure, operation, error) {
  if (typeof onFailure === 'function') {
    onFailure(operation, error);
    return;
  }
  process.stderr.write(`[caipira-inject] ${operation} failed: ${error && error.message}\n`);
}

// One review rule for every rendered fact. A stale fact is still worth
// injecting, but it must say so rather than present itself as current: the
// needs_review state alone earns the flag, and changed paths make it specific.
// Symbol evidence the parser could not re-check this run is neither drift nor
// confirmation, so it earns the flag too, saying only that.
/**
 * @param {{kind: string, id: number, summary: string, state?: string}} fact
 * @param {string[]} [stale] Evidence paths that changed since the fact was recorded.
 * @param {boolean} [unchecked] Whether some of its symbol evidence could not be checked.
 * @returns {string}
 */
function factLine(fact, stale = [], unchecked = false) {
  const reasons = [];
  if (stale.length) reasons.push(`changed since recorded: ${stale.join(', ')}`);
  if (unchecked) reasons.push('symbol evidence could not be checked');
  const flag = reasons.length
    ? ` (NEEDS REVIEW — ${reasons.join('; ')})`
    : fact.state === 'needs_review' ? ' (NEEDS REVIEW)' : '';
  return `- [${fact.kind}#${fact.id}] ${fact.summary}${flag}`;
}

// Only summaries are injected, never bodies: the summary is written to be
// self-contained, and the body is one search_facts call away when needed.
/** @param {InjectionCandidate[]} selected @returns {string|null} */
function renderInjection(selected) {
  if (selected.length === 0) return null;

  const lines = ['Caipira recalled these established facts for this workspace:'];
  let budget = MAX_CHARS;

  for (const { fact, stale, unchecked } of selected) {
    const line = factLine(fact, stale, unchecked);
    if (line.length > budget) continue;
    budget -= line.length;
    lines.push(line);
  }

  if (lines.length === 1) return null;
  lines.push('These are settled answers, not hints. Act on them directly rather than re-reading files or re-running checks to reconfirm them; verify only what is marked NEEDS REVIEW. If one is contradicted by what you find, call update_fact instead of silently working around it.');
  return lines.join('\n');
}

/**
 * @param {object} db Open workspace database.
 * @param {string} prompt
 * @param {{machine?: string, root?: string, astScope?: AstRefreshScope, onFailure?: RecallFailureHandler}} [opts]
 * @returns {string|null} null when nothing is recalled; a storage failure is reported through
 *   onFailure (stderr by default) and also yields null.
 */
function buildPromptInjection(db, prompt, opts = {}) {
  try {
    return renderInjection(selectFacts(db, prompt, opts));
  } catch (error) {
    reportFailure(opts.onFailure, 'prompt facts', error);
    return null;
  }
}

// SessionStart has no prompt to match against, so it carries only the small
// set of standing facts, and only the ones still verified.
/**
 * @param {object} db Open workspace database.
 * @param {{limit?: number, onFailure?: RecallFailureHandler}} [opts]
 * @returns {string|null} null when there are no standing facts or they cannot be read (reported).
 */
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
    `).all(opts.limit || MAX_STANDING_FACTS);
    if (rows.length === 0) return null;

    const lines = ['Caipira standing facts for this workspace:'];
    for (const fact of rows) {
      const flag = fact.state === 'needs_review' ? ' (NEEDS REVIEW — evidence changed)' : '';
      lines.push(`- [${fact.kind}#${fact.id}] ${fact.summary}${flag}`);
    }
    lines.push('Act on these directly — do not re-derive anything they cover. Use search_facts for the full body or for facts not listed here, check_drift before trusting one whose files may have moved, and record_fact for anything settled this session that is not already here.');
    return lines.join('\n');
  } catch (error) {
    reportFailure(opts.onFailure, 'standing facts', error);
    return null;
  }
}

// Plain code-unit order, as SQLite's default BINARY collation sorts paths, so
// the map is byte-identical whatever locale the hook runs under.
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const symbolPlace = (a, b) => compareText(a.path, b.path) || a.start - b.start || compareText(a.qualified, b.qualified);

// Workspace-relative POSIX form of target, or null at base itself or outside
// it. Whole components are compared, so "..tools" is a directory, not a way
// out; a different Windows drive comes back absolute and is outside too.
/** @param {typeof path} pathApi @param {string} base @param {string} target @returns {string|null} */
function relativeInside(pathApi, base, target) {
  const relative = pathApi.relative(base, target);
  if (!relative || pathApi.isAbsolute(relative)) return null;
  const parts = relative.split(pathApi.sep);
  return parts[0] === '..' ? null : parts.join('/');
}

/** @param {string} target @returns {string|null} */
function realpathOrNull(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

/**
 * Where a session runs inside its workspace, for locality ranking.
 *
 * A workspace keeps the spelling it was first registered under, which can be
 * a symlink to the directory a later session reports as its cwd, so both are
 * compared by their real paths. When either cannot be resolved (deleted, or
 * never created) both are compared as written instead. Workspace identity
 * and database routing are not affected.
 * @param {string|null|undefined} root Workspace root as registered.
 * @param {string|undefined} cwd Directory the session reports.
 * @param {{pathApi?: typeof path, realpath?: (target: string) => string|null}} [adapters]
 *   Path rules (path.win32 for Windows comparison) and resolver; the host's by default.
 * @returns {{subpath: string, roots: string[], realRoot: string|null}} subpath is '' at the root or
 *   outside it; roots are the spellings of the root that recorded evidence paths may start with,
 *   and realRoot the resolved one, when it resolves.
 */
function locateSession(root, cwd, adapters = {}) {
  const pathApi = adapters.pathApi || path;
  const realpath = adapters.realpath || realpathOrNull;
  if (typeof root !== 'string' || !root) return { subpath: '', roots: [], realRoot: null };
  const lexicalRoot = pathApi.resolve(root);
  if (typeof cwd !== 'string' || !cwd) return { subpath: '', roots: [lexicalRoot], realRoot: null };
  const realRoot = realpath(root);
  const realCwd = realpath(cwd);
  const subpath = (realRoot && realCwd
    ? relativeInside(pathApi, realRoot, realCwd)
    : relativeInside(pathApi, lexicalRoot, pathApi.resolve(cwd))) || '';
  return { subpath, roots: [...new Set([lexicalRoot, realRoot].filter(Boolean))], realRoot: realRoot || null };
}

/** @param {string} subpath @param {string|null} relPath @returns {boolean} */
function withinSubpath(subpath, relPath) {
  return Boolean(subpath && relPath) && (relPath === subpath || relPath.startsWith(`${subpath}/`));
}

/**
 * Whether a recorded evidence file lies in the session's subdirectory.
 *
 * Evidence keeps whichever spelling of the root was current when it was
 * recorded, so it is placed by the same rules as the session itself: by real
 * paths when the file and the root both resolve, so a file recorded through
 * another alias of the root still counts; as written, against each spelling of
 * the root, when the file is gone, so deleted evidence keeps the place it was
 * recorded under. The path rules decide case and drive, as for the cwd.
 * @param {{subpath: string, roots: string[], realRoot: string|null}} place From locateSession.
 * @param {string} file Absolute evidence path as recorded.
 * @param {{pathApi?: typeof path, realpath?: (target: string) => string|null}} [adapters]
 *   The same path rules and resolver place was located with; the host's by default.
 * @returns {boolean}
 */
function isLocalEvidence(place, file, adapters = {}) {
  if (!place.subpath) return false;
  const pathApi = adapters.pathApi || path;
  const realpath = adapters.realpath || realpathOrNull;
  const realFile = place.realRoot ? realpath(file) : null;
  const spellings = realFile ? [[place.realRoot, realFile]] : place.roots.map(root => [root, pathApi.resolve(file)]);
  return spellings.some(([root, target]) => {
    const dir = pathApi.join(root, ...place.subpath.split('/'));
    return pathApi.relative(dir, target) === '' || relativeInside(pathApi, dir, target) !== null;
  });
}

/**
 * Renders the workspace's public symbol map within `room` characters.
 *
 * Session start pays for the map once, so prompt turns never repeat it and
 * the conversation prefix stays cacheable. When the map outgrows its room,
 * what survives is what the agent most likely needs: the active subpath,
 * then the most depended-on symbols, then the shallowest files. Every kept
 * symbol outranks every omitted one, and the kept lines are printed in
 * (subpath, path, line) order so the same index always renders the same text.
 * When not even one symbol fits, the header and omission notice alone still
 * tell the agent the symbols exist.
 * @param {object} db Open workspace database.
 * @param {string} subpath Workspace-relative directory the session runs in, or ''.
 * @param {number} room Characters available for the whole block.
 * @returns {string|null} null when there are no public symbols or not even the notice fits.
 * @throws {Error} When the symbol index cannot be read.
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
    local: withinSubpath(subpath, row.path) ? 1 : 0,
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
  if (kept.length === 0) {
    const notice = `${header}\n${footer(symbols.length)}`;
    return notice.length <= room ? notice : null;
  }

  kept.sort((a, b) => b.local - a.local || symbolPlace(a, b));
  const lines = [header, ...kept.map(symbol => symbol.line)];
  if (kept.length < symbols.length) lines.push(footer(symbols.length - kept.length));
  return lines.join('\n');
}

// The facts a block of recall carries, ranked: prompt score first, then
// kind, then locality to the session's subdirectory, newest breaking ties.
// A prompt's selection checks evidence itself; standing facts take what the
// caller's verification could not check.
/**
 * @param {object} db
 * @param {{root: string}|null|undefined} workspace
 * @param {{prompt?: string, machine?: string, astScope?: AstRefreshScope, uncheckedFacts?: ReadonlySet<number>}} opts
 * @param {{subpath: string, roots: string[], realRoot: string|null}} place
 * @returns {object[]}
 */
function rankedFacts(db, workspace, opts, place) {
  const unchecked = opts.uncheckedFacts || new Set();
  const facts = opts.prompt
    ? selectFacts(db, opts.prompt, { machine: opts.machine, root: workspace?.root, astScope: opts.astScope })
      .map(row => ({ ...row.fact, score: row.score, stale: row.stale, unchecked: row.unchecked }))
    : db.prepare(`SELECT *, 0 AS score FROM facts WHERE state IN ('active','needs_review')
        ORDER BY updated_at DESC LIMIT ?`).all(STANDING_CANDIDATES)
      .map(fact => ({ ...fact, unchecked: unchecked.has(fact.id) }));
  if (facts.length === 0) return facts;

  // Evidence files are recorded as absolute paths under whichever spelling of
  // the root was current, symbol evidence as workspace-relative paths; both
  // are judged by the same subpath.
  const locality = new Set();
  if (place.subpath) {
    const candidates = new Set(facts.map(fact => fact.id));
    for (const row of db.prepare(`SELECT fact_id, path FROM fact_evidence`).all()) {
      if (candidates.has(row.fact_id) && !locality.has(row.fact_id) && isLocalEvidence(place, row.path)) {
        locality.add(row.fact_id);
      }
    }
    for (const row of db.prepare(`SELECT fact_id, path FROM fact_symbol_evidence`).all()) {
      if (withinSubpath(place.subpath, row.path)) locality.add(row.fact_id);
    }
  }
  const rank = fact => fact.score + (KIND_WEIGHT[fact.kind] || 0) + (locality.has(fact.id) ? LOCALITY_BONUS : 0);
  return facts.sort((a, b) => rank(b) - rank(a) || b.updated_at - a.updated_at);
}

/**
 * Builds bounded recall. Without a prompt (session start) it carries standing
 * facts, recent session digests, and the public symbol map; with one it
 * carries only the facts the prompt recalls, or nothing.
 *
 * Each block is built on its own, so a block that fails to read is left out
 * and reported through onFailure (stderr by default) while the blocks that
 * did build are kept. A prompt turn whose facts cannot be read returns null.
 * @param {object} db Open workspace database.
 * @param {{root: string}} workspace Resolved workspace.
 * @param {{cwd?: string, budget?: number, prompt?: string, machine?: string, astScope?: AstRefreshScope,
 *   uncheckedFacts?: ReadonlySet<number>, onFailure?: RecallFailureHandler}} [opts]
 *   budget defaults to PROMPT_BUDGET_CHARS and is capped at MAX_BUDGET_CHARS. uncheckedFacts are the
 *   facts the caller's verification left with unchecked evidence; standing facts among them are flagged.
 * @returns {string|null} null when there is nothing to say.
 */
function buildInjection(db, workspace, opts = {}) {
  const budget = Math.max(0, Math.min(MAX_BUDGET_CHARS,
    Number.isInteger(opts.budget) ? opts.budget : PROMPT_BUDGET_CHARS));
  if (!budget) return null;
  const attempt = (operation, build) => {
    try {
      return build();
    } catch (error) {
      reportFailure(opts.onFailure, operation, error);
      return null;
    }
  };
  const place = locateSession(workspace?.root, opts.cwd);

  const facts = attempt(opts.prompt ? 'prompt facts' : 'standing facts',
    () => rankedFacts(db, workspace, opts, place)) || [];
  // A prompt turn carries what the prompt recalled or nothing: repeating
  // session context here would only break the cached prefix.
  if (opts.prompt && facts.length === 0) return null;

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
    for (const fact of facts.slice(0, MAX_STANDING_FACTS)) add(factLine(fact, fact.stale, fact.unchecked));
  }
  if (!opts.prompt) {
    const sessions = attempt('session digests', () => db.prepare(`SELECT summary FROM sessions
      WHERE summary IS NOT NULL AND trim(summary) != ''
      ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?`).all(RECENT_SESSION_DIGESTS)) || [];
    if (sessions.length && add('Recent sessions:')) {
      for (const session of sessions) add(`- ${session.summary}`);
    }
    const symbols = attempt('workspace symbols',
      () => selectWorkspaceSymbols(db, place.subpath, budget - used - (blocks.length ? 1 : 0)));
    if (symbols) add(symbols);
  }
  return blocks.length ? blocks.join('\n') : null;
}

// Facts whose evidence files have moved. Unlike prompt injection this is not
// a relevance judgement and needs no threshold: the fingerprints already prove
// the ground truth changed, so the only question is whether the fact survived
// the change. Surfaced unconditionally, because a stale fact that keeps being
// injected is worse than one nobody recorded.
/**
 * @param {object} db Open workspace database.
 * @param {{limit?: number, onFailure?: RecallFailureHandler}} [opts]
 * @returns {string|null} null when nothing drifted or the facts cannot be read (reported).
 */
function buildDriftNotice(db, opts = {}) {
  try {
    const rows = db.prepare(`
      SELECT f.id, f.kind, f.summary,
             (SELECT GROUP_CONCAT(path, '|') FROM fact_evidence WHERE fact_id = f.id) AS paths
      FROM facts f WHERE f.state = 'needs_review'
      ORDER BY f.updated_at DESC LIMIT ?
    `).all(opts.limit || DRIFT_NOTICE_LIMIT);
    if (rows.length === 0) return null;

    const lines = ['Caipira facts whose evidence changed — resolve before relying on them:'];
    for (const row of rows) {
      const files = (row.paths || '').split('|').filter(Boolean).map(p => p.split(/[\\/]/).pop());
      lines.push(`- [${row.kind}#${row.id}] ${row.summary}${files.length ? ` (changed: ${[...new Set(files)].join(', ')})` : ''}`);
    }
    lines.push('For each: if it still holds, reaffirm it via update_fact; if the change made it wrong, update_fact with the correction, or revoke it and record_fact the replacement with supersedes.');
    return lines.join('\n');
  } catch (error) {
    reportFailure(opts.onFailure, 'drift notice', error);
    return null;
  }
}

module.exports = {
  buildPromptInjection, buildStandingInjection, buildInjection, buildDriftNotice, selectFacts, renderInjection,
  selectWorkspaceSymbols, locateSession, isLocalEvidence, coverageOf, termGroups, MIN_COVERAGE, MIN_TRUST, MAX_FACTS,
  PROMPT_BUDGET_CHARS, STARTUP_BUDGET_CHARS, MAX_BUDGET_CHARS
};
