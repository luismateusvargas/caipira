// caipira/store.js — Port of cavemem MemoryStore + Storage
// Compress observations before storing. Expand on retrieval.
// Embedding support via @xenova/transformers (loaded lazily in MCP server).
// Hybrid search: FTS5 BM25 + cosine similarity rerank.

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const { compress, expand, countTokens } = require('./compress');

// CAIPIRA_HOME redirects the store, so tests never touch the real database.
const DEFAULT_DB = path.join(
  process.env.CAIPIRA_HOME ? path.resolve(process.env.CAIPIRA_HOME) : path.join(os.homedir(), '.caipira'),
  'data.db'
);

// ── PRIVACY ──

const PRIVATE_RE = /<private>[\s\S]*?<\/private>/gi;
function redactPrivate(input) {
  const closed = input.replace(PRIVATE_RE, '');
  const idx = closed.search(/<private>/i);
  if (idx >= 0) return closed.slice(0, idx);
  return closed;
}

// ── SCHEMA ──

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  ide TEXT NOT NULL DEFAULT 'codewhale',
  cwd TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  compressed INTEGER NOT NULL DEFAULT 1,
  intensity TEXT,
  ts INTEGER NOT NULL,
  metadata TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  content,
  content='observations',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS embeddings (
  observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('turn','session')),
  content TEXT NOT NULL,
  compressed INTEGER NOT NULL DEFAULT 1,
  intensity TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
`;

const INSERT_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

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

function hybridRank(items, alpha) {
  const bm25s = items.map(x => x.bm25 ?? 0);
  const cosines = items.map(x => x.cosine ?? 0);
  const [bmin, bmax] = [Math.min(...bm25s), Math.max(...bm25s)];
  const [cmin, cmax] = [Math.min(...cosines), Math.max(...cosines)];
  const bRange = bmax - bmin || 1;
  const cRange = cmax - cmin || 1;
  return items.map(x => {
    const b = ((x.bm25 ?? bmin) - bmin) / bRange;
    const c = ((x.cosine ?? cmin) - cmin) / cRange;
    return { id: x.id, score: alpha * b + (1 - alpha) * c };
  }).sort((a, b) => b.score - a.score);
}

// Observations are stored compressed, so a raw query term cannot match its
// stored form — "database" never matches a stored "db". Search every form a
// term could take: as typed, compressed at each intensity, and expanded.
const SEARCH_INTENSITIES = ['full', 'ultra'];

function hasSearchableChars(s) {
  return /[\p{L}\p{N}]/u.test(s);
}

// Terms the compressor also strips from stored content (articles, fillers)
// yield no usable form and are dropped rather than made to match nothing.
function termForms(term) {
  const forms = new Set();
  const add = (value) => {
    const trimmed = (value || '').trim();
    if (trimmed && hasSearchableChars(trimmed)) forms.add(trimmed);
  };
  // Expand first, then compress the expansion: an already-abbreviated query
  // ('cfg') otherwise never reaches the other intensity's form ('config').
  const expanded = expand(term);
  for (const base of new Set([term, expanded])) {
    add(base);
    for (const intensity of SEARCH_INTENSITIES) add(compress(base, { intensity }));
  }
  return Array.from(forms);
}

function queryForms(query) {
  return Array.from(new Set(query.split(/\s+/).filter(Boolean).flatMap(termForms)));
}

function ftsQuote(s) { return `"${s.replace(/"/g, '""')}"`; }

// AND across terms, OR within each term's forms. Returns '' when no term
// survives, which searchFts treats as "skip FTS".
function sanitizeMatch(q) {
  return q.split(/\s+/).filter(Boolean)
    .map(termForms)
    .filter(forms => forms.length > 0)
    .map(forms => forms.length === 1 ? ftsQuote(forms[0]) : `(${forms.map(ftsQuote).join(' OR ')})`)
    .join(' AND ');
}

// ── STORAGE ──

class Storage {
  constructor(dbPath) {
    this.dbPath = dbPath || DEFAULT_DB;
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(SCHEMA_SQL);
    try { this.db.exec(INSERT_TRIGGERS); } catch {}
    const v = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    if (!v || v.v === null) {
      this.db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (1)').run();
    }
  }

  // ── sessions ──

  createSession({ id, ide, cwd, started_at, metadata }) {
    return this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, ide, cwd, started_at, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, ide || 'codewhale', cwd || null, started_at || Date.now(), metadata || null);
  }

  endSession(id) {
    return this.db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).run(Date.now(), id);
  }

  listSessions(limit = 20) {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?`).all(limit);
  }

  // ── observations ──

  insertObservation(obs) {
    const info = this.db.prepare(`
      INSERT INTO observations (session_id, kind, content, compressed, intensity, ts, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(obs.session_id, obs.kind, obs.content, obs.compressed ? 1 : 0, obs.intensity || null, obs.ts || Date.now(), obs.metadata ? (typeof obs.metadata === 'string' ? obs.metadata : JSON.stringify(obs.metadata)) : null);
    return Number(info.lastInsertRowid);
  }

  getObservations(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM observations WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);
  }

  countObservations() {
    return this.db.prepare('SELECT COUNT(*) as c FROM observations').get().c;
  }

  // ── summaries ──

  insertSummary(s) {
    return this.db.prepare(`
      INSERT INTO summaries (session_id, scope, content, compressed, intensity, ts)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(s.session_id, s.scope, s.content, s.compressed ? 1 : 0, s.intensity || null, s.ts || Date.now());
  }

  listSummaries(sessionId) {
    return this.db.prepare(`SELECT * FROM summaries WHERE session_id = ? ORDER BY ts DESC`).all(sessionId);
  }

  // ── FTS5 search ──

  searchFts(query, limit = 10) {
    if (!query || !query.trim()) return [];
    const match = sanitizeMatch(query);
    let rows = [];
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

  putEmbedding(observationId, model, vec) {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db.prepare(
      "INSERT OR REPLACE INTO embeddings(observation_id, model, dim, vec) VALUES (?, ?, ?, ?)"
    ).run(observationId, model, vec.length, buf);
  }

  getEmbedding(observationId) {
    const row = this.db.prepare("SELECT model, dim, vec FROM embeddings WHERE observation_id = ?").get(observationId);
    if (!row) return undefined;
    const vec = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.dim);
    return { model: row.model, dim: row.dim, vec };
  }

  allEmbeddings(filter) {
    const rows = filter
      ? this.db.prepare("SELECT observation_id, dim, vec FROM embeddings WHERE model = ? AND dim = ?").all(filter.model, filter.dim)
      : this.db.prepare("SELECT observation_id, dim, vec FROM embeddings").all();
    return rows.map(r => ({
      observation_id: r.observation_id,
      vec: new Float32Array(new Uint8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength).slice().buffer)
    }));
  }

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

  dropEmbeddingsWhereModelNot(model) {
    const info = this.db.prepare("DELETE FROM embeddings WHERE model != ?").run(model);
    return Number(info.changes);
  }

  countEmbeddings(filter) {
    if (filter) {
      return this.db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE model = ? AND dim = ?").get(filter.model, filter.dim).n;
    }
    return this.db.prepare("SELECT COUNT(*) AS n FROM embeddings").get().n;
  }

  close() { this.db.close(); }
}

// ── MEMORY STORE ──

const DEFAULT_SETTINGS = {
  compression: { intensity: 'full', expandForModel: false },
  search: { alpha: 0.5, defaultLimit: 10 },
  embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2' }
};

class MemoryStore {
  constructor(opts = {}) {
    this.storage = new Storage(opts.dbPath);
    this.settings = opts.settings || DEFAULT_SETTINGS;
  }

  close() { this.storage.close(); }

  // ── sessions ──

  startSession(p) {
    this.storage.createSession({ id: p.id, ide: p.ide, cwd: p.cwd, started_at: Date.now(), metadata: null });
  }

  endSession(id) {
    this.storage.endSession(id);
  }

  listSessions(limit) {
    return this.storage.listSessions(limit);
  }

  ensureSession(id) {
    this.storage.createSession({ id, ide: 'unknown', cwd: null, started_at: Date.now(), metadata: null });
  }

  // ── observations (WITH compression) ──

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

  addSummary(p) {
    const redacted = redactPrivate(p.content);
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

  timeline(sessionId, aroundId, limit = 20) {
    const rows = aroundId
      ? this.storage.db.prepare(`SELECT * FROM observations WHERE session_id = ? AND id BETWEEN ? AND ? ORDER BY id LIMIT ?`).all(sessionId, Math.max(0, aroundId - limit / 2), aroundId + limit / 2, limit)
      : this.storage.db.prepare(`SELECT * FROM observations WHERE session_id = ? ORDER BY id DESC LIMIT ?`).all(sessionId, limit);
    return rows.map(r => ({ id: r.id, session_id: r.session_id, kind: r.kind, content: r.content, ts: r.ts }));
  }

  countObservations() { return this.storage.countObservations(); }
  listSummaries(sessionId) { return this.storage.listSummaries(sessionId); }

  // ── search ──

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

module.exports = { MemoryStore, Storage };
