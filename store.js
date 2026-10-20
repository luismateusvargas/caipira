// caipira/store.js — Port of cavemem MemoryStore + Storage
// Compress observations before storing. Expand on retrieval.
// Embedding support via @xenova/transformers (loaded lazily in MCP server).
// Hybrid search: FTS5 BM25 + cosine similarity rerank.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { LEXICON, compress, expand, countTokens, queryForms, buildAndMatch } = require('./compress');
const { migrate, WORKSPACE_MIGRATIONS } = require('./migrate');

// CAIPIRA_HOME redirects the store, so tests never touch the real database.
const DEFAULT_DB = path.join(
  process.env.CAIPIRA_HOME ? path.resolve(process.env.CAIPIRA_HOME) : path.join(os.homedir(), '.caipira'),
  'data.db'
);

// ── PRIVACY ──

const PRIVATE_RE = /<private>[\s\S]*?<\/private>/gi;
function redactPrivate(input) {
  if (typeof input !== 'string') return '';
  const closed = input.replace(PRIVATE_RE, '');
  const idx = closed.search(/<private>/i);
  if (idx >= 0) return closed.slice(0, idx);
  return closed;
}

// ── RANKING ──

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Min/max over the values actually present: an item with no cosine is
// unscored, not scored 0, and a loop survives corpora too large to spread
// into Math.min().
function bounds(items, key) {
  let min = Infinity, max = -Infinity;
  for (const item of items) {
    const v = item[key];
    if (v == null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

function hybridRank(items, alpha) {
  const b = bounds(items, 'bm25');
  const c = bounds(items, 'cosine');
  return items.map(x => {
    // A lone or tied keyword hit is a full match, not the bottom of a range.
    const bn = x.bm25 == null ? 0
      : b.max === b.min ? (b.max > 0 ? 1 : 0)
      : (x.bm25 - b.min) / (b.max - b.min);
    const cn = x.cosine == null ? 0 : (x.cosine - c.min) / (c.max - c.min || 1);
    return { id: x.id, score: alpha * bn + (1 - alpha) * cn };
  }).sort((a, b) => b.score - a.score);
}

// Node may hand back a pooled Buffer at any byte offset, and a Float32Array
// view must start on a 4-byte boundary, so copy into a buffer of its own.
function toFloat32(blob) {
  return new Float32Array(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength).slice().buffer);
}

/** @typedef {{id: number, session_id: string, snippet: string, score: number, ts: number}} KeywordHit */
/** @typedef {{id: number, session_id: string, snippet: string, content: string, score: number, ts: number, metadata: null}} SearchHit */
/** @typedef {{model: string, dim: number, embed: (text: string) => Promise<Float32Array>}} Embedder */

// ── STORAGE ──

/** Raw SQL access to one workspace database: sessions, observations, summaries, embeddings. */
class Storage {
  /** @param {string} [dbPath] Database file; defaults to the legacy data.db. */
  constructor(dbPath) {
    this.dbPath = dbPath || DEFAULT_DB;
    this.db = new Database(this.dbPath);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      migrate(this.db, WORKSPACE_MIGRATIONS);
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  // ── sessions ──

  // ensureSession() can register a session as 'unknown' before its start
  // event arrives; the real start then fills in what the placeholder lacked
  // without overwriting anything already known.
  /** @param {{id: string, ide?: string, cwd?: string|null, started_at?: number, metadata?: string|null}} session */
  createSession({ id, ide, cwd, started_at, metadata }) {
    return this.db.prepare(`
      INSERT INTO sessions (id, ide, cwd, started_at, metadata)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ide = CASE WHEN sessions.ide = 'unknown' AND excluded.ide != 'unknown' THEN excluded.ide ELSE sessions.ide END,
        cwd = COALESCE(sessions.cwd, excluded.cwd)
    `).run(id, ide || 'codewhale', cwd || null, started_at || Date.now(), metadata || null);
  }

  /** @param {string} id */
  endSession(id) {
    return this.db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).run(Date.now(), id);
  }

  /** @param {number} [limit] @returns {object[]} Newest first. */
  listSessions(limit = 20) {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?`).all(limit);
  }

  // ── observations ──

  /** @param {object} obs Row fields; content is stored as given. @returns {number} New observation id. */
  insertObservation(obs) {
    const info = this.db.prepare(`
      INSERT INTO observations (session_id, kind, content, compressed, intensity, ts, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(obs.session_id, obs.kind, obs.content, obs.compressed ? 1 : 0, obs.intensity || null, obs.ts || Date.now(), obs.metadata ? (typeof obs.metadata === 'string' ? obs.metadata : JSON.stringify(obs.metadata)) : null);
    return Number(info.lastInsertRowid);
  }

  /** @param {number[]} ids @returns {object[]} Raw rows in id order. */
  getObservations(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM observations WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);
  }

  /** @returns {number} */
  countObservations() {
    return this.db.prepare('SELECT COUNT(*) as c FROM observations').get().c;
  }

  // ── summaries ──

  /** @param {object} s Row fields; content is stored as given. */
  insertSummary(s) {
    return this.db.prepare(`
      INSERT INTO summaries (session_id, scope, content, compressed, intensity, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(s.session_id, s.scope, s.content, s.compressed ? 1 : 0, s.intensity || null, s.ts || Date.now());
  }

  /** @param {string} sessionId @returns {object[]} Newest first. */
  listSummaries(sessionId) {
    return this.db.prepare(`SELECT * FROM summaries WHERE session_id = ? ORDER BY ts DESC`).all(sessionId);
  }

  // ── FTS5 search ──

  /** @param {string} query @param {number} [limit] @returns {KeywordHit[]} Higher score is better. */
  searchFts(query, limit = 10) {
    if (!query || !query.trim()) return [];
    const match = buildAndMatch(query);
    let rows = [];
    // A query of nothing but stopwords leaves no FTS term at all.
    if (match) {
      try {
        rows = this.db.prepare(`
          SELECT o.id, o.session_id, o.ts,
                 snippet(observations_fts, 0, '[', ']', '\u2026', 16) AS snippet,
                 bm25(observations_fts) AS score
          FROM observations_fts
          JOIN observations o ON o.id = observations_fts.rowid
          WHERE observations_fts MATCH ?
          ORDER BY score ASC
          LIMIT ?
        `).all(match, limit);
      } catch {
        rows = [];
      }
    }
    // Fallback: if FTS5 returned nothing or threw, try LIKE with OR across terms
    if (rows.length === 0) {
      const terms = queryForms(query);
      if (terms.length > 0) {
        const clauses = terms.map(() => `o.content LIKE ? ESCAPE '\\'`).join(' OR ');
        const params = terms.map(t => `%${t.replace(/[%_\\]/g, '\\$&')}%`);
        rows = this.db.prepare(`
          SELECT o.id, o.session_id, o.ts,
                 substr(o.content, 1, 120) AS snippet,
                 -1.0 AS score
          FROM observations o
          WHERE ${clauses}
          ORDER BY o.ts DESC LIMIT ?
        `).all(...params, limit);
      }
    }
    return rows.map(r => ({
      id: r.id,
      session_id: r.session_id,
      snippet: r.snippet,
      score: -r.score,  // FTS5 bm25 lower=better → flip sign
      ts: r.ts
    }));
  }

  // ── embeddings ──

  /** @param {number} observationId @param {string} model @param {Float32Array} vec */
  putEmbedding(observationId, model, vec) {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db.prepare(
      "INSERT OR REPLACE INTO embeddings(observation_id, model, dim, vec) VALUES (?, ?, ?, ?)"
    ).run(observationId, model, vec.length, buf);
  }

  /** @param {number} observationId @returns {{model: string, dim: number, vec: Float32Array}|undefined} */
  getEmbedding(observationId) {
    const row = this.db.prepare("SELECT model, dim, vec FROM embeddings WHERE observation_id = ?").get(observationId);
    if (!row) return undefined;
    return { model: row.model, dim: row.dim, vec: toFloat32(row.vec) };
  }

  /** @param {{model: string, dim: number}} [filter] @returns {{observation_id: number, vec: Float32Array}[]} */
  allEmbeddings(filter) {
    const rows = filter
      ? this.db.prepare("SELECT observation_id, dim, vec FROM embeddings WHERE model = ? AND dim = ?").all(filter.model, filter.dim)
      : this.db.prepare("SELECT observation_id, dim, vec FROM embeddings").all();
    return rows.map(r => ({
      observation_id: r.observation_id,
      vec: toFloat32(r.vec)
    }));
  }

  /** @param {number} [limit] @param {string} [model] @returns {object[]} Rows with no embedding (for model, if given). */
  observationsMissingEmbeddings(limit = 100, model) {
    if (model) {
      return this.db.prepare(`
        SELECT o.* FROM observations o
        LEFT JOIN embeddings e ON e.observation_id = o.id AND e.model = ?
        WHERE e.observation_id IS NULL
        ORDER BY o.id DESC LIMIT ?
      `).all(model, limit);
    }
    return this.db.prepare(`
      SELECT o.* FROM observations o
      LEFT JOIN embeddings e ON e.observation_id = o.id
      WHERE e.observation_id IS NULL
      ORDER BY o.id DESC LIMIT ?
    `).all(limit);
  }

  /** @param {string} model @returns {number} Rows deleted. */
  dropEmbeddingsWhereModelNot(model) {
    const info = this.db.prepare("DELETE FROM embeddings WHERE model != ?").run(model);
    return Number(info.changes);
  }

  /** @param {{model: string, dim: number}} [filter] @returns {number} */
  countEmbeddings(filter) {
    if (filter) {
      return this.db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE model = ? AND dim = ?").get(filter.model, filter.dim).n;
    }
    return this.db.prepare("SELECT COUNT(*) AS n FROM embeddings").get().n;
  }

  close() { this.db.close(); }
}

// ── MEMORY STORE ──

// `caipira mode <lite|full|ultra>` writes the active intensity next to this
// file; a missing or unrecognised value falls back to full.
function activeIntensity() {
  try {
    const mode = fs.readFileSync(path.join(__dirname, 'active'), 'utf8').trim();
    if (Object.hasOwn(LEXICON.fillers, mode)) return mode;
  } catch {}
  return 'full';
}

const DEFAULT_SETTINGS = {
  compression: { intensity: activeIntensity(), expandForModel: false },
  search: { alpha: 0.5, defaultLimit: 10 },
  embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2' }
};

/** Observation memory for one workspace: redacts and compresses on write, ranks on search. */
class MemoryStore {
  /** @param {{dbPath?: string, settings?: typeof DEFAULT_SETTINGS}} [opts] */
  constructor(opts = {}) {
    this.storage = new Storage(opts.dbPath);
    this.settings = opts.settings || DEFAULT_SETTINGS;
  }

  close() { this.storage.close(); }

  // ── sessions ──

  /** @param {{id: string, ide?: string, cwd?: string}} p */
  startSession(p) {
    this.storage.createSession({ id: p.id, ide: p.ide, cwd: p.cwd, started_at: Date.now(), metadata: null });
  }

  endSession(id) {
    this.storage.endSession(id);
  }

  listSessions(limit) {
    return this.storage.listSessions(limit);
  }

  /** Register a placeholder session; a later startSession() fills in ide and cwd. @param {string} id @param {string} [ide] @param {string|null} [cwd] */
  ensureSession(id, ide = 'unknown', cwd = null) {
    this.storage.createSession({ id, ide, cwd, started_at: Date.now(), metadata: null });
  }

  // ── observations (WITH compression) ──

  /** @param {{session_id: string, kind: string, content: string, metadata?: object|string}} p @returns {number} New id, or -1 when nothing survives redaction. */
  addObservation(p) {
    const redacted = redactPrivate(p.content);
    if (!redacted.trim()) return -1;
    this.ensureSession(p.session_id);
    const intensity = this.settings.compression.intensity;
    const compressed = compress(redacted, { intensity });
    const obs = {
      session_id: p.session_id,
      kind: p.kind,
      content: compressed,
      compressed: true,
      intensity,
      ts: Date.now(),
      metadata: p.metadata ? (typeof p.metadata === 'string' ? p.metadata : JSON.stringify(p.metadata)) : null
    };
    return this.storage.insertObservation(obs);
  }

  /** @param {{session_id: string, scope: 'turn'|'session', content: string}} p @returns {object|null} Run result, or null when nothing survives redaction. */
  addSummary(p) {
    const redacted = redactPrivate(p.content);
    if (!redacted.trim()) return null;
    this.ensureSession(p.session_id);
    const intensity = this.settings.compression.intensity;
    const out = compress(redacted, { intensity });
    return this.storage.insertSummary({
      session_id: p.session_id,
      scope: p.scope,
      content: out,
      compressed: true,
      intensity,
      ts: Date.now()
    });
  }

  // ── reads ──

  /** @param {number[]} ids @param {{expand?: boolean}} [opts] @returns {object[]} */
  getObservations(ids, opts = {}) {
    const wantExpand = opts.expand ?? this.settings.compression.expandForModel;
    return this.storage.getObservations(ids).map(r => ({
      id: r.id,
      session_id: r.session_id,
      kind: r.kind,
      content: wantExpand ? expand(r.content) : r.content,
      compressed: !wantExpand && r.compressed === 1,
      intensity: r.intensity,
      ts: r.ts,
      metadata: r.metadata ? safeJSON(r.metadata) : null
    }));
  }

  /** @param {string} sessionId @param {number|null} [aroundId] @param {number} [limit] @returns {object[]} */
  timeline(sessionId, aroundId, limit = 20) {
    const rows = aroundId
      ? this.storage.db.prepare(`SELECT * FROM observations WHERE session_id = ? AND id BETWEEN ? AND ? ORDER BY id LIMIT ?`).all(sessionId, Math.max(0, aroundId - limit / 2), aroundId + limit / 2, limit)
      : this.storage.db.prepare(`SELECT * FROM observations WHERE session_id = ? ORDER BY id DESC LIMIT ?`).all(sessionId, limit);
    return rows.map(r => ({ id: r.id, session_id: r.session_id, kind: r.kind, content: r.content, ts: r.ts }));
  }

  countObservations() { return this.storage.countObservations(); }
  listSummaries(sessionId) { return this.storage.listSummaries(sessionId); }

  // ── search ──

  /**
   * Keyword search, reranked against embeddings when an embedder is given.
   * @param {string} query @param {number} [limit] @param {Embedder|null} [embedder]
   * @returns {Promise<SearchHit[]>}
   */
  async search(query, limit, embedder) {
    const cap = limit ?? this.settings.search.defaultLimit;
    const alpha = this.settings.search.alpha;
    const keyword = this.storage.searchFts(query, cap * 2);

    if (!embedder || this.settings.embedding.provider === 'none') {
      return keyword.slice(0, cap).map(k => ({
        id: k.id, session_id: k.session_id, snippet: k.snippet,
        content: '', score: k.score, ts: k.ts,
        metadata: null
      }));
    }

    const vectors = this.storage.allEmbeddings({ model: embedder.model, dim: embedder.dim });
    if (vectors.length === 0) {
      return keyword.slice(0, cap).map(k => ({
        id: k.id, session_id: k.session_id, snippet: k.snippet,
        content: '', score: k.score, ts: k.ts,
        metadata: null
      }));
    }

    const qvec = await embedder.embed(query);
    if (qvec.length !== embedder.dim) {
      return keyword.slice(0, cap).map(k => ({
        id: k.id, session_id: k.session_id, snippet: k.snippet,
        content: '', score: k.score, ts: k.ts,
        metadata: null
      }));
    }

    const scored = vectors.map(v => ({ id: v.observation_id, cosine: cosine(qvec, v.vec) }));
    const merged = new Map();
    for (const k of keyword) merged.set(k.id, { bm25: k.score });
    for (const s of scored) {
      const cur = merged.get(s.id) ?? {};
      cur.cosine = s.cosine;
      merged.set(s.id, cur);
    }

    const ranked = hybridRank(Array.from(merged, ([id, v]) => ({ id, ...v })), alpha).slice(0, cap);

    const infoById = new Map(keyword.map(k => [k.id, { session_id: k.session_id, snippet: k.snippet, ts: k.ts }]));
    const missing = ranked.filter(r => !infoById.has(r.id)).map(r => r.id);
    if (missing.length) {
      for (const row of this.storage.getObservations(missing)) {
        infoById.set(row.id, { session_id: row.session_id, snippet: row.content.slice(0, 120), ts: row.ts });
      }
    }

    return ranked.map(r => {
      const info = infoById.get(r.id);
      return {
        id: r.id, session_id: info?.session_id ?? '', snippet: info?.snippet ?? '',
        content: '', score: r.score, ts: info?.ts ?? 0, metadata: null
      };
    });
  }

  // ── embedding management (for MCP server) ──

  putEmbedding(observationId, model, vec) {
    return this.storage.putEmbedding(observationId, model, vec);
  }

  observationsMissingEmbeddings(limit, model) {
    return this.storage.observationsMissingEmbeddings(limit, model);
  }

  countEmbeddings(filter) {
    return this.storage.countEmbeddings(filter);
  }

  dropEmbeddingsWhereModelNot(model) {
    return this.storage.dropEmbeddingsWhereModelNot(model);
  }
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return s; }
}

module.exports = { MemoryStore, Storage, redactPrivate };
