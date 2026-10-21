// caipira/facts.js — the knowledge layer.
//
// A fact is a statement that is currently true, as opposed to an observation,
// which is a thing that happened. Facts are revisable, supersedable, and carry
// the fingerprints of the files they came from, so a later session can trust
// them without re-reading those files.
//
// The staleness check is deliberately two-tier: stat every evidence file
// (microseconds, no read), and hash only the ones whose size or mtime moved.
// mtime lies — git checkouts, clock skew, touch — so the hash is what decides,
// and the stat is only there to decide whether hashing is worth it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildAndMatch: buildMatch, termForms } = require('./compress');
const { canonicalKey } = require('./workspace');

const VALID_KINDS = ['decision', 'constraint', 'preference', 'status', 'gotcha'];
const VALID_STATES = ['active', 'needs_review', 'superseded', 'revoked', 'proposed'];

// Facts that are worth re-checking on a clock, not just on file changes.
const DEFAULT_TTL_DAYS = { status: 14, decision: null, constraint: null, preference: null, gotcha: null };

/** @typedef {{checked: number, unchanged: number, changed: number, missing: number, unverified: number, foreign: number, changedPaths: string[]}} EvidenceStatus */
/** @typedef {{kind: string, title: string, body: string, summary?: string, scope?: string, evidence?: string[], evidence_ranges?: {path: string, start_line: number, end_line: number}[], evidenceSymbols?: {path: string, qualifiedName: string, signatureHash: string}[], confidence?: number, ttl_days?: number, session_id?: string, supersedes?: number, state?: string}} FactInput */
/** @typedef {Partial<FactInput>} FactChanges */

/** @param {unknown} value @returns {boolean} */
function validConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** @param {unknown} value @returns {boolean} */
function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// ── fingerprinting ──

/** @param {string} filePath @returns {string} */
function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/** @param {string} filePath @returns {{path: string, size: number, mtime: number, sha256: string}} */
function fingerprint(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('not a regular file');
  return {
    path: path.resolve(filePath),
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    sha256: hashFile(filePath)
  };
}

// ── trust ──

// A highly relevant fact whose evidence has moved should rank below a less
// relevant one that is still verified: relevance says "about the same thing",
// trust says "still true", and only their product is worth injecting.
/** @param {object} fact @param {EvidenceStatus} [evidenceStatus] @returns {number} */
function trustScore(fact, evidenceStatus) {
  const stateWeight = { active: 1.0, proposed: 0.6, needs_review: 0.35, superseded: 0, revoked: 0 };
  let score = (stateWeight[fact.state] ?? 0) * (fact.confidence ?? 1);

  // Only penalise evidence drift on a fact still claiming to be active. Once
  // it has been marked needs_review the state weight already accounts for it,
  // and applying both would bury a stale-but-relevant fact below the gate —
  // which is the opposite of useful, since drift is exactly what the agent
  // most needs told about.
  if (evidenceStatus && fact.state !== 'needs_review') {
    if (evidenceStatus.changed > 0) score *= 0.3;
    else if (evidenceStatus.missing > 0) score *= 0.6;
    if (evidenceStatus.foreign > 0 && evidenceStatus.checked === 0) score *= 0.8;
  }

  if (fact.ttl_days && fact.last_verified_at) {
    const ageDays = (Date.now() - fact.last_verified_at) / 86400000;
    if (ageDays > fact.ttl_days) score *= 0.5;
  }
  return score;
}

// ── store ──

/** Stores and verifies durable facts in one workspace database. */
class FactStore {
  /** @param {import('better-sqlite3').Database} db @param {{machine?: string, agent?: string, root?: string}} [opts] */
  constructor(db, opts = {}) {
    this.db = db;
    this.machine = opts.machine || 'unknown';
    this.agent = opts.agent || 'unknown';
    this.root = opts.root || null;
  }

  // ── writes ──

  /** @param {FactInput} input @returns {number} New fact ID. */
  record({ kind, title, body, summary, scope, evidence, evidence_ranges = [], evidenceSymbols = [], confidence, ttl_days, session_id, supersedes, state }) {
    if (!VALID_KINDS.includes(kind)) throw new Error(`kind must be one of: ${VALID_KINDS.join(', ')}`);
    if (!nonEmptyText(title) || !nonEmptyText(body)) throw new Error('title and body are required');
    if (state !== undefined && !VALID_STATES.includes(state)) throw new Error(`invalid state: ${state}`);
    if (confidence !== undefined && !validConfidence(confidence)) throw new Error('confidence must be a number from 0 to 1');
    if (supersedes !== undefined && supersedes !== null &&
        (!Number.isSafeInteger(supersedes) || !this.db.prepare('SELECT id FROM facts WHERE id = ?').get(supersedes))) {
      throw new Error(`no fact to supersede with id ${supersedes}`);
    }
    if (!Array.isArray(evidenceSymbols) || evidenceSymbols.some(s => !s ||
        !nonEmptyText(s.path) || !nonEmptyText(s.qualifiedName) || !nonEmptyText(s.signatureHash))) {
      throw new Error('evidenceSymbols must contain resolved symbols');
    }
    if (!Array.isArray(evidence_ranges) || evidence_ranges.some(range => !range ||
        !nonEmptyText(range.path) || !Number.isSafeInteger(range.start_line) ||
        !Number.isSafeInteger(range.end_line) || range.start_line < 1 ||
        range.end_line < range.start_line)) {
      throw new Error('evidence_ranges must contain a path and valid inclusive line range');
    }

    const now = Date.now();
    const ttl = ttl_days !== undefined ? ttl_days : DEFAULT_TTL_DAYS[kind] ?? null;

    const insert = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO facts
          (kind, scope, title, body, summary, state, supersedes, confidence, ttl_days,
           created_at, updated_at, last_checked_at, last_verified_at,
           created_by, updated_by, machine, source_session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        kind, scope || null, title, body, summary || title,
        state || 'active', supersedes || null, confidence ?? 1.0, ttl,
        now, now, now, now,
        this.agent, this.agent, this.machine, session_id || null
      );
      const factId = Number(info.lastInsertRowid);

      for (const file of evidence || []) {
        this.attachEvidence(factId, file);
      }
      for (const range of evidence_ranges) {
        this.attachEvidence(factId, range.path);
        this.db.prepare(`UPDATE fact_evidence SET start_line = ?, end_line = ?
          WHERE fact_id = ? AND path = ? AND machine = ?`)
          .run(range.start_line, range.end_line, factId, path.resolve(range.path), this.machine);
      }
      for (const symbol of evidenceSymbols) {
        this.db.prepare(`INSERT INTO fact_symbol_evidence
          (fact_id, path, qualified_name, signature_hash) VALUES (?, ?, ?, ?)`)
          .run(factId, symbol.path, symbol.qualifiedName, symbol.signatureHash);
        if (this.root) this.attachEvidence(factId, path.join(this.root, symbol.path));
      }

      // Superseding is a state transition on the old fact, never a delete:
      // the history of what was decided and then changed is the point.
      if (supersedes) {
        this.db.prepare(
          `UPDATE facts SET state = 'superseded', updated_at = ?, updated_by = ? WHERE id = ?`
        ).run(now, this.agent, supersedes);
      }
      return factId;
    });

    return insert();
  }

  /** @param {number} factId @param {string} filePath @returns {void} */
  attachEvidence(factId, filePath) {
    let fp;
    try {
      fp = fingerprint(filePath);
    } catch {
      // A path we cannot fingerprint is still worth recording as provenance;
      // it simply cannot contribute to verification.
      fp = { path: path.resolve(filePath), size: null, mtime: null, sha256: null };
    }
    this.db.prepare(`
      INSERT INTO fact_evidence (fact_id, path, sha256, size, mtime, machine, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fact_id, path, machine) DO UPDATE SET
        sha256 = excluded.sha256, size = excluded.size,
        mtime = excluded.mtime, recorded_at = excluded.recorded_at
    `).run(factId, fp.path, fp.sha256, fp.size, fp.mtime, this.machine, Date.now());
  }

  /** @param {number} id @param {FactChanges} changes @returns {object} Updated fact with evidence. */
  update(id, changes) {
    const fact = this.get(id);
    if (!fact) throw new Error(`no fact with id ${id}`);
    if (!changes || typeof changes !== 'object') throw new Error('changes must be an object');
    if (changes.state !== undefined && !VALID_STATES.includes(changes.state)) {
      throw new Error(`invalid state: ${changes.state}`);
    }
    if (changes.kind !== undefined && !VALID_KINDS.includes(changes.kind)) {
      throw new Error(`kind must be one of: ${VALID_KINDS.join(', ')}`);
    }
    for (const key of ['title', 'body']) {
      if (changes[key] !== undefined && !nonEmptyText(changes[key])) throw new Error(`${key} must be non-empty text`);
    }
    if (changes.confidence !== undefined && !validConfidence(changes.confidence)) {
      throw new Error('confidence must be a number from 0 to 1');
    }
    if (changes.evidence !== undefined &&
        (!Array.isArray(changes.evidence) || changes.evidence.some(file => !nonEmptyText(file)))) {
      throw new Error('evidence must be an array of file paths');
    }

    const allowed = ['kind', 'scope', 'title', 'body', 'summary', 'state', 'confidence', 'ttl_days'];
    const sets = [], values = [];
    for (const key of allowed) {
      if (changes[key] !== undefined) { sets.push(`${key} = ?`); values.push(changes[key]); }
    }
    if (sets.length === 0 && changes.evidence === undefined) return fact;

    const now = Date.now();
    sets.push('updated_at = ?', 'updated_by = ?');
    values.push(now, this.agent, id);
    const apply = this.db.transaction(() => {
      this.db.prepare(`UPDATE facts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      if (Array.isArray(changes.evidence)) {
        this.db.prepare('DELETE FROM fact_evidence WHERE fact_id = ? AND machine = ?').run(id, this.machine);
        for (const file of changes.evidence) this.attachEvidence(id, file);
      }

      // Explicit activation re-baselines evidence even when the stored state
      // was already active and the underlying files had changed.
      if (changes.state === 'active') this.reaffirm(id);
      return this.get(id);
    });
    return apply();
  }

  // Re-baseline every evidence file recorded on this machine, and mark the
  // fact verified as of now.
  /** @param {number} id @returns {object} Re-baselined active fact. */
  reaffirm(id) {
    const rows = this.db.prepare(
      'SELECT path FROM fact_evidence WHERE fact_id = ? AND machine = ?'
    ).all(id, this.machine);
    for (const row of rows) this.attachEvidence(id, row.path);
    this.db.prepare(`UPDATE fact_symbol_evidence SET signature_hash =
      (SELECT signature_hash FROM ast_symbols WHERE path = fact_symbol_evidence.path
       AND qualified_name = fact_symbol_evidence.qualified_name ORDER BY start_line LIMIT 1)
      WHERE fact_id = ? AND EXISTS
      (SELECT 1 FROM ast_symbols WHERE path = fact_symbol_evidence.path
       AND qualified_name = fact_symbol_evidence.qualified_name)`).run(id);

    const now = Date.now();
    this.db.prepare(
      `UPDATE facts SET state = 'active', last_checked_at = ?, last_verified_at = ?, updated_by = ? WHERE id = ?`
    ).run(now, now, this.agent, id);
    return this.get(id);
  }

  /** @param {number} id @returns {object} Revoked fact. */
  revoke(id) { return this.update(id, { state: 'revoked' }); }

  // ── reads ──

  /** @param {number} id @returns {object|null} Fact with evidence, if found. */
  get(id) {
    const fact = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id);
    if (!fact) return null;
    fact.evidence = this.db.prepare('SELECT * FROM fact_evidence WHERE fact_id = ?').all(id);
    fact.symbol_evidence = this.db.prepare('SELECT * FROM fact_symbol_evidence WHERE fact_id = ?').all(id);
    return fact;
  }

  // Two-tier: stat gates the hash, hash gates the verdict.
  /** @param {number} factId @returns {EvidenceStatus} */
  checkEvidence(factId) {
    const rows = this.db.prepare('SELECT * FROM fact_evidence WHERE fact_id = ?').all(factId);
    const symbols = this.db.prepare('SELECT * FROM fact_symbol_evidence WHERE fact_id = ?').all(factId);
    const status = { checked: 0, unchanged: 0, changed: 0, missing: 0, unverified: 0, foreign: 0, changedPaths: [], broken: [] };
    const symbolsByPath = new Map();
    for (const symbol of symbols) {
      const group = symbolsByPath.get(symbol.path) || [];
      group.push(symbol);
      symbolsByPath.set(symbol.path, group);
    }
    const refreshed = new Set();
    const unavailable = new Set();
    const refreshAst = relPath => {
      if (!this.root || refreshed.has(relPath)) return;
      refreshed.add(relPath);
      const indexed = this.db.prepare('SELECT size, mtime_ms FROM ast_files WHERE path = ?').get(relPath);
      let stat;
      try { stat = fs.statSync(path.join(this.root, relPath)); } catch { /* deletion needs an AST update */ }
      if (stat && indexed && indexed.size === stat.size && indexed.mtime_ms === Math.floor(stat.mtimeMs)) return;
      try {
        const { updateFileAst } = require('./ast');
        updateFileAst(this.root, this.db.name, path.join(this.root, relPath), { timeoutMs: 2000 });
      } catch { unavailable.add(relPath); }
    };

    for (const row of rows) {
      // Evidence recorded on another machine cannot be verified here; treating
      // it as stale would make an imported memory permanently untrusted.
      if (row.machine !== this.machine) { status.foreign++; continue; }
      if (!row.sha256) { status.unverified++; continue; }

      let stat;
      try {
        stat = fs.statSync(row.path);
      } catch {
        status.missing++;
        status.changedPaths.push(row.path);
        continue;
      }

      if (!stat.isFile()) {
        status.changed++;
        status.changedPaths.push(row.path);
        continue;
      }

      status.checked++;
      if (stat.size === row.size && Math.floor(stat.mtimeMs) === row.mtime) {
        status.unchanged++;
        continue;
      }

      // Size or mtime moved — now the hash decides.
      let digest;
      try { digest = hashFile(row.path); } catch { digest = null; }
      if (digest && digest === row.sha256) {
        // Touched but identical: refresh the cheap fields so the next session
        // takes the fast path again.
        this.db.prepare('UPDATE fact_evidence SET size = ?, mtime = ? WHERE id = ?')
          .run(stat.size, Math.floor(stat.mtimeMs), row.id);
        status.unchanged++;
      } else {
        const relPath = this.root ? path.relative(this.root, row.path).split(path.sep).join('/') : null;
        const anchored = relPath && symbolsByPath.has(relPath);
        if (anchored) {
          refreshAst(relPath);
          const allCurrent = symbolsByPath.get(relPath).every(symbol => {
            const current = this.db.prepare(`SELECT signature_hash FROM ast_symbols
              WHERE path = ? AND qualified_name = ? ORDER BY start_line LIMIT 1`)
              .get(relPath, symbol.qualified_name);
            return !unavailable.has(relPath) && current && current.signature_hash === symbol.signature_hash;
          });
          if (allCurrent) {
            this.db.prepare('UPDATE fact_evidence SET sha256 = ?, size = ?, mtime = ? WHERE id = ?')
              .run(digest, stat.size, Math.floor(stat.mtimeMs), row.id);
            status.unchanged++;
            continue;
          }
        }
        status.changed++;
        status.changedPaths.push(row.path);
      }
    }
    for (const symbol of symbols) {
      refreshAst(symbol.path);
      const exists = !this.root || fs.existsSync(path.join(this.root, symbol.path));
      const current = exists && this.db.prepare(`SELECT signature_hash FROM ast_symbols
        WHERE path = ? AND qualified_name = ? ORDER BY start_line LIMIT 1`)
        .get(symbol.path, symbol.qualified_name);
      if (unavailable.has(symbol.path) && exists) continue;
      if (!current || current.signature_hash !== symbol.signature_hash) {
        status.broken.push({ path: symbol.path, symbol: symbol.qualified_name,
          reason: current ? 'symbol_signature_changed' : 'symbol_missing' });
        const absolute = this.root ? path.join(this.root, symbol.path) : symbol.path;
        if (!status.changedPaths.includes(absolute)) status.changedPaths.push(absolute);
      }
    }
    if (status.broken.length && status.changed === 0 && status.missing === 0) status.changed = status.broken.length;
    return status;
  }

  // Re-checks facts and flips those whose evidence moved into needs_review.
  /** @param {number[]} [ids] @returns {(EvidenceStatus & {id: number, title: string, drifted: boolean, ttlExpired: boolean})[]} */
  verify(ids) {
    const targets = ids && ids.length
      ? ids
      : this.db.prepare(`SELECT id FROM facts WHERE state IN ('active','needs_review')`).all().map(r => r.id);

    const now = Date.now();
    const results = [];
    for (const id of targets) {
      const fact = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id);
      if (!fact) continue;
      const status = this.checkEvidence(id);
      const ttlExpired = Boolean(fact.ttl_days && fact.last_verified_at &&
        (now - fact.last_verified_at) / 86400000 > fact.ttl_days);
      const drifted = status.changed > 0 || status.missing > 0 || ttlExpired;

      if (drifted && fact.state === 'active') {
        this.db.prepare(`UPDATE facts SET state = 'needs_review', last_checked_at = ? WHERE id = ?`)
          .run(now, id);
      } else if (!drifted && fact.state === 'needs_review' && status.checked > 0) {
        // Evidence came back into line (a revert, or the fact was re-recorded).
        this.db.prepare(`UPDATE facts SET state = 'active', last_checked_at = ?, last_verified_at = ? WHERE id = ?`)
          .run(now, now, id);
      } else if (!drifted && status.checked > 0) {
        this.db.prepare('UPDATE facts SET last_checked_at = ?, last_verified_at = ? WHERE id = ?')
          .run(now, now, id);
      } else {
        this.db.prepare('UPDATE facts SET last_checked_at = ? WHERE id = ?').run(now, id);
      }
      results.push({ id, kind: fact.kind, title: fact.title, summary: fact.summary,
        ...status, drifted, ttlExpired });
    }
    return results;
  }

  // Which facts rest on these files. Lets PostToolUse re-verify only the facts
  // a write could actually have invalidated, instead of the whole table.
  // Canonical keys resolve symlinks and fold case on Windows, where the same
  // evidence file may be reached through several spellings.
  /** @param {string[]} paths @param {string} [baseDir] @returns {number[]} */
  factsForPaths(paths, baseDir) {
    const wanted = new Set(paths.filter(Boolean).map(p => canonicalKey(baseDir ? path.resolve(baseDir, p) : path.resolve(p))));
    if (wanted.size === 0) return [];
    const rows = this.db.prepare(`
      SELECT DISTINCT e.fact_id AS id, e.path
      FROM fact_evidence e JOIN facts f ON f.id = e.fact_id
      WHERE f.state IN ('active','needs_review') AND e.machine = ?
    `).all(this.machine);
    if (this.root) {
      for (const row of this.db.prepare(`SELECT e.fact_id AS id, e.path FROM fact_symbol_evidence e
        JOIN facts f ON f.id = e.fact_id WHERE f.state IN ('active','needs_review')`).all()) {
        rows.push({ id: row.id, path: path.join(this.root, row.path) });
      }
    }
    const hits = new Set();
    for (const row of rows) {
      if (wanted.has(canonicalKey(row.path))) hits.add(row.id);
    }
    return [...hits];
  }

  // Facts whose evidence moved — the diff between what was decided and what
  // the code now says. Drift is a query, not a guess.
  /** @returns {object[]} Facts currently marked for review. */
  drifted() {
    return this.db.prepare(`
      SELECT f.id, f.title, f.summary, f.updated_at,
             (SELECT GROUP_CONCAT(path, '|') FROM fact_evidence WHERE fact_id = f.id) AS paths
      FROM facts f WHERE f.state = 'needs_review' ORDER BY f.updated_at DESC
    `).all();
  }

  // ── search ──
  //
  // Lexical recall only. Semantic reranking needs an embedder and lives in the
  // caller, which is the only place that has one.
  /** @param {string} query @param {{limit?: number, states?: string[]}} [opts] @returns {object[]} */
  search(query, opts = {}) {
    const limit = opts.limit || 10;
    const states = opts.states || ['active', 'needs_review', 'proposed'];
    const match = buildMatch(query || '');
    const placeholders = states.map(() => '?').join(',');

    let rows = [];
    if (match) {
      try {
        rows = this.db.prepare(`
          SELECT f.*, bm25(facts_fts, 10.0, 6.0, 1.0) AS bm25
          FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
          WHERE facts_fts MATCH ? AND f.state IN (${placeholders})
          ORDER BY bm25 ASC LIMIT ?
        `).all(match, ...states, limit * 3);
      } catch { rows = []; }
    }

    return rows.map(fact => {
      const evidence = this.checkEvidence(fact.id);
      return {
        ...fact,
        lexical: -fact.bm25,
        trust: trustScore(fact, evidence),
        evidence_status: evidence
      };
    }).sort((a, b) => b.trust - a.trust || b.lexical - a.lexical).slice(0, limit);
  }

  /** @param {number} [limit] @returns {object[]} */
  listActive(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM facts WHERE state = 'active' ORDER BY updated_at DESC LIMIT ?
    `).all(limit);
  }

  /** @returns {number} */
  count() {
    return this.db.prepare('SELECT COUNT(*) n FROM facts').get().n;
  }
}

// ── cross-workspace recall ──
//
// Explicitly requested, never injected. Facts from another project are borrowed
// context: they were settled against a codebase that is not this one, so they
// can inform an answer but must never silently become a premise. Every result
// is therefore tagged with the workspace it came from.
//
// Ranking note: each workspace has its own FTS index, so bm25 is relative to
// that workspace's corpus and scores are NOT comparable between them. ATTACH
// would not fix this — an attached database keeps its own index and its own
// statistics. So results are fused by rank, not by score: a workspace's top hit
// is worth the same as any other workspace's top hit, and trust breaks ties.
const RRF_K = 60;

/** @param {string} query @param {object} [opts] @returns {object[]} */
function searchWorkspaces(query, opts = {}) {
  const { listWorkspaces, openWorkspaceDb } = require('./workspace');
  const machine = opts.machine;
  const limit = opts.limit || 10;
  const perWorkspace = opts.perWorkspace || Math.max(limit, 5);
  const skip = (opts.skipKeys || []).map(k => String(k).toLowerCase());

  const fused = [];
  for (const row of listWorkspaces()) {
    if (skip.includes(String(row.canonical_key).toLowerCase())) continue;
    // A registry row whose database is gone is not an error worth failing the
    // whole search over — prune removes these, but a search must not depend on
    // prune having been run.
    if (!fs.existsSync(row.db_file)) continue;

    let db = null;
    try {
      db = openWorkspaceDb(row.db_file);
      const store = new FactStore(db, { machine, agent: opts.agent || 'search', root: row.root_path });
      const hits = store.search(query, { limit: perWorkspace, states: opts.states });
      hits.forEach((fact, index) => {
        fused.push({
          ...fact,
          workspace: row.root_path || row.label || row.canonical_key,
          workspace_id: row.id,
          workspace_label: row.label,
          rank_in_workspace: index + 1,
          rrf: 1 / (RRF_K + index + 1)
        });
      });
    } catch {
      // A corrupt or locked workspace database must not take the others down.
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
  }

  return fused
    .sort((a, b) => (b.rrf * b.trust) - (a.rrf * a.trust) || b.trust - a.trust)
    .slice(0, limit);
}

module.exports = {
  FactStore, fingerprint, hashFile, trustScore, buildMatch, termForms,
  searchWorkspaces, RRF_K, VALID_KINDS, VALID_STATES
};
