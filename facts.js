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
const { compress, expand } = require('./compress');

const VALID_KINDS = ['decision', 'constraint', 'preference', 'status', 'gotcha'];
const VALID_STATES = ['active', 'needs_review', 'superseded', 'revoked', 'proposed'];

// Facts that are worth re-checking on a clock, not just on file changes.
const DEFAULT_TTL_DAYS = { status: 14, decision: null, constraint: null, preference: null, gotcha: null };

// ── fingerprinting ──

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function fingerprint(filePath) {
  const stat = fs.statSync(filePath);
  return {
    path: path.resolve(filePath),
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    sha256: hashFile(filePath)
  };
}

// ── dual-form query, shared with observation search ──

const SEARCH_INTENSITIES = ['full', 'ultra'];

function termForms(term) {
  const forms = new Set();
  const add = (value) => {
    const trimmed = (value || '').trim();
    if (trimmed && /[\p{L}\p{N}]/u.test(trimmed)) forms.add(trimmed);
  };
  const expanded = expand(term);
  for (const base of new Set([term, expanded])) {
    add(base);
    for (const intensity of SEARCH_INTENSITIES) add(compress(base, { intensity }));
  }
  return Array.from(forms);
}

function ftsQuote(s) { return `"${s.replace(/"/g, '""')}"`; }

function buildMatch(query) {
  return query.split(/\s+/).filter(Boolean)
    .map(termForms)
    .filter(forms => forms.length > 0)
    .map(forms => forms.length === 1 ? ftsQuote(forms[0]) : `(${forms.map(ftsQuote).join(' OR ')})`)
    .join(' AND ');
}

// ── trust ──

// A highly relevant fact whose evidence has moved should rank below a less
// relevant one that is still verified: relevance says "about the same thing",
// trust says "still true", and only their product is worth injecting.
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

class FactStore {
  constructor(db, opts = {}) {
    this.db = db;
    this.machine = opts.machine || 'unknown';
    this.agent = opts.agent || 'unknown';
  }

  // ── writes ──

  record({ kind, title, body, summary, scope, evidence, confidence, ttl_days, session_id, supersedes, state }) {
    if (!VALID_KINDS.includes(kind)) throw new Error(`kind must be one of: ${VALID_KINDS.join(', ')}`);
    if (!title || !body) throw new Error('title and body are required');
    if (state && !VALID_STATES.includes(state)) throw new Error(`invalid state: ${state}`);

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

  update(id, changes) {
    const fact = this.get(id);
    if (!fact) throw new Error(`no fact with id ${id}`);
    if (changes.state && !VALID_STATES.includes(changes.state)) {
      throw new Error(`invalid state: ${changes.state}`);
    }

    const allowed = ['kind', 'scope', 'title', 'body', 'summary', 'state', 'confidence', 'ttl_days'];
    const sets = [], values = [];
    for (const key of allowed) {
      if (changes[key] !== undefined) { sets.push(`${key} = ?`); values.push(changes[key]); }
    }
    if (sets.length === 0) return fact;

    const now = Date.now();
    sets.push('updated_at = ?', 'updated_by = ?');
    values.push(now, this.agent, id);
    this.db.prepare(`UPDATE facts SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    // Clearing needs_review means someone looked at the changed files and
    // decided the fact still holds. Without re-fingerprinting, the very next
    // check would flip it straight back — so returning a fact to active is
    // what re-baselines its evidence.
    if (changes.state === 'active' && fact.state !== 'active') this.reaffirm(id);
    return this.get(id);
  }

  // Re-baseline every evidence file recorded on this machine, and mark the
  // fact verified as of now.
  reaffirm(id) {
    const rows = this.db.prepare(
      'SELECT path FROM fact_evidence WHERE fact_id = ? AND machine = ?'
    ).all(id, this.machine);
    for (const row of rows) this.attachEvidence(id, row.path);

    const now = Date.now();
    this.db.prepare(
      `UPDATE facts SET state = 'active', last_checked_at = ?, last_verified_at = ?, updated_by = ? WHERE id = ?`
    ).run(now, now, this.agent, id);
    return this.get(id);
  }

  revoke(id) { return this.update(id, { state: 'revoked' }); }

  // ── reads ──

  get(id) {
    const fact = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id);
    if (!fact) return null;
    fact.evidence = this.db.prepare('SELECT * FROM fact_evidence WHERE fact_id = ?').all(id);
    return fact;
  }

  // Two-tier: stat gates the hash, hash gates the verdict.
  checkEvidence(factId) {
    const rows = this.db.prepare('SELECT * FROM fact_evidence WHERE fact_id = ?').all(factId);
    const status = { checked: 0, unchanged: 0, changed: 0, missing: 0, foreign: 0, changedPaths: [] };

    for (const row of rows) {
      // Evidence recorded on another machine cannot be verified here; treating
      // it as stale would make an imported memory permanently untrusted.
      if (row.machine !== this.machine) { status.foreign++; continue; }
      if (!row.sha256) { status.missing++; continue; }

      let stat;
      try {
        stat = fs.statSync(row.path);
      } catch {
        status.missing++;
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
        status.changed++;
        status.changedPaths.push(row.path);
      }
    }
    return status;
  }

  // Re-checks facts and flips those whose evidence moved into needs_review.
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
      const drifted = status.changed > 0 || status.missing > 0;

      if (drifted && fact.state === 'active') {
        this.db.prepare(`UPDATE facts SET state = 'needs_review', last_checked_at = ? WHERE id = ?`)
          .run(now, id);
      } else if (!drifted && fact.state === 'needs_review' && status.checked > 0) {
        // Evidence came back into line (a revert, or the fact was re-recorded).
        this.db.prepare(`UPDATE facts SET state = 'active', last_checked_at = ?, last_verified_at = ? WHERE id = ?`)
          .run(now, now, id);
      } else {
        this.db.prepare(`UPDATE facts SET last_checked_at = ?${drifted ? '' : ', last_verified_at = ?'} WHERE id = ?`)
          .run(...(drifted ? [now, id] : [now, now, id]));
      }
      results.push({ id, title: fact.title, ...status, drifted });
    }
    return results;
  }

  // Which facts rest on these files. Lets PostToolUse re-verify only the facts
  // a write could actually have invalidated, instead of the whole table.
  // Paths are compared case-insensitively: Windows reaches the same file
  // through different casing, and evidence is stored as it was first seen.
  factsForPaths(paths) {
    const wanted = new Set(paths.filter(Boolean).map(p => path.resolve(p).toLowerCase()));
    if (wanted.size === 0) return [];
    const rows = this.db.prepare(`
      SELECT DISTINCT e.fact_id AS id, e.path
      FROM fact_evidence e JOIN facts f ON f.id = e.fact_id
      WHERE f.state IN ('active','needs_review') AND e.machine = ?
    `).all(this.machine);
    const hits = new Set();
    for (const row of rows) {
      if (wanted.has(path.resolve(row.path).toLowerCase())) hits.add(row.id);
    }
    return [...hits];
  }

  // Facts whose evidence moved — the diff between what was decided and what
  // the code now says. Drift is a query, not a guess.
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

  listActive(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM facts WHERE state = 'active' ORDER BY updated_at DESC LIMIT ?
    `).all(limit);
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) n FROM facts').get().n;
  }
}

module.exports = {
  FactStore, fingerprint, hashFile, trustScore, buildMatch, termForms,
  VALID_KINDS, VALID_STATES
};
