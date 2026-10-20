# Fix workspace root resolution, master registry writes, and store reliability

Status: done
Project rules: specs/project.md#constitution
Target files: workspace.js, store.js, test/test-workspace.js, test/test-hook.js
Depends on: specs/tasks/01-compression-and-query-expansion.md

## Outcome and boundary

Fix `findRoot()` in `workspace.js` so monorepo subdirectories resolve to the enclosing repository/workspace root instead of splitting into per-package databases, stop `adoptLegacy()` from issuing a write transaction on every `openMaster()` call, unify `Storage` schema initialization with `migrate.js`, and fix session metadata upsert, `Float32Array` alignment, `active` mode loading, and `hybridRank` edge cases in `store.js`.

## Acceptance criteria

1. Calling `findRoot()` on a subdirectory containing a nested `package.json` or `Cargo.toml` inside a parent directory containing `.git`, `.hg`, or `.caipira-workspace` returns the parent repository/workspace root, while a standalone project with only `package.json` (and no parent VCS marker below `os.homedir()`) resolves to that `package.json` directory.
2. Calling `openMaster()` / `listWorkspaces()` / `ensureWorkspace()` repeatedly when `LEGACY_DB` is already registered does not execute `INSERT OR IGNORE` or advance `sqlite_sequence` in `master.db`.
3. `Storage` initializes databases via `migrate(this.db, WORKSPACE_MIGRATIONS)` (reaching schema version 2), `Storage.getEmbedding()` returns a valid `Float32Array` even when the underlying Node `Buffer` has an unaligned `byteOffset` (`byteOffset % 4 !== 0`), `startSession()` updates `ide` and `cwd` on a session previously created by `ensureSession()`, and `MemoryStore.search()` returns a positive score when only a single observation matches.

## Implementation plan

1. In `workspace.js`:
   - Split `ROOT_MARKERS` into `VCS_MARKERS = ['.caipira-workspace', '.git', '.hg']` and `MANIFEST_MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle']`.
   - In `findRoot(startDir)`: collect the ancestor chain from `path.resolve(startDir || process.cwd())` up to (but not including `os.homedir()` itself, unless `startDir` is `os.homedir()`). Pass 1: return the first ancestor matching `.caipira-workspace`, or the outermost/nearest ancestor matching `.git`/`.hg`. Pass 2 (only if no VCS/workspace marker exists in the chain): return the first ancestor matching `MANIFEST_MARKERS`. Fallback: `path.resolve(startDir || process.cwd())`.
   - In `adoptLegacy(master)`: check `master.prepare('SELECT 1 FROM workspaces WHERE canonical_key = ? AND machine = ?').get(LEGACY_KEY, machineId())` before running the `INSERT` statement.
   - In `openMaster()` and `openWorkspaceDb(dbFile)`: wrap `pragma`, `migrate()`, and `adoptLegacy()` in `try`/`catch (err) { db.close(); throw err; }` so failed initialization never leaks a file descriptor.
   - Add JSDoc (`@typedef`, `@param`, `@returns`) to exported functions.
2. In `store.js`:
   - Replace `SCHEMA_SQL`, `INSERT_TRIGGERS`, and `_initSchema()` with `migrate(this.db, WORKSPACE_MIGRATIONS)` imported from `./migrate`.
   - Read the active compression intensity from `path.join(__dirname, 'active')` (falling back to `'full'` if missing or invalid) when building `DEFAULT_SETTINGS`.
   - Guard `redactPrivate(input)` with `if (typeof input !== 'string') return '';`, and in `MemoryStore.addSummary(p)`, return early if `!redacted.trim()`.
   - Update `Storage.createSession()` to `INSERT INTO sessions (id, ide, cwd, started_at, metadata) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ide = CASE WHEN sessions.ide = 'unknown' AND excluded.ide != 'unknown' THEN excluded.ide ELSE sessions.ide END, cwd = COALESCE(sessions.cwd, excluded.cwd)`. Update `MemoryStore.ensureSession(id, ide = 'unknown', cwd = null)` to forward optional `ide` and `cwd`.
   - In `Storage.searchFts(query, limit)`: check `if (match)` before running the FTS5 `MATCH` query (avoiding throwing and catching a SQLite syntax error on stopword-only queries).
   - In `Storage.getEmbedding(observationId)`: copy the blob slice into an aligned buffer (`new Float32Array(new Uint8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength).slice().buffer)`) matching `allEmbeddings()`.
   - In `hybridRank(items, alpha)`: compute min/max using a loop over defined `bm25` and `cosine` values (avoiding `Math.min(...arr)` stack overflow and avoiding polluting `cmax` with `0` when cosines are negative), and when `bmax === bmin` (single hit or tied hits with `bmax > 0`), normalize `b = 1` instead of `0`.
   - Add JSDoc (`@typedef`, `@param`, `@returns`) to `Storage` and `MemoryStore`.
3. In `test/test-workspace.js` and `test/test-hook.js`:
   - Add tests in `test/test-workspace.js` for monorepo `findRoot` resolution (nested `package.json`/`Cargo.toml` inside a `.git` root), `sqlite_sequence` stability across repeated `openMaster()` calls, `Storage.getEmbedding()` with unaligned buffer slices, `ensureSession()` -> `startSession()` metadata upgrade, and single-hit `hybridRank()` scoring.
   - In `test/test-hook.js` line 89, replace `require(ROOT + '/node_modules/better-sqlite3')` with `require('better-sqlite3')`.

## Verification

- Run `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-workspace.js` and `test/test-hook.js`; expect all assertions to pass (`0 failed`).

## Open decisions and sources

None.
