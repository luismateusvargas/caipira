# Fix fact verification, TTL drift, and prompt-injection precision

Status: implemented
Project rules: specs/project.md#constitution
Target files: facts.js, inject.js, test/test-facts.js, test/test-inject.js
Depends on: specs/tasks/01-compression-and-query-expansion.md

## Outcome and boundary

Fix evidence verification and TTL drift handling in `facts.js` and tighten prompt-injection filtering and rendering in `inject.js` so un-fingerprinted provenance paths do not cause false drift, expired `status` facts are flagged, drifted active facts always render with `NEEDS REVIEW`, 2-letter lexicon abbreviations (`db`, `fn`, `tx`, `mw`) are recalled, and 3+ letter English stopwords (`when`, `this`, `that`) do not trigger false-positive fact injections.

## Acceptance criteria

1. Recording a fact with a non-existent provenance path (`sha256: null`) or a directory path does not cause `verify()` (`check_drift`) to mark the fact as `drifted: true` / `state: 'needs_review'`, whereas deleting an previously fingerprinted file (`sha256 !== null`) marks the fact `needs_review` and lists the deleted path in `changedPaths`.
2. A fact whose `ttl_days` has elapsed (`(Date.now() - last_verified_at) / 86400000 > ttl_days`) is flipped to `state: 'needs_review'` by `verify()` instead of having `last_verified_at` silently reset to `now`; calling `update(id, { state: 'active' })` re-baselines evidence via `reaffirm(id)` regardless of whether the prior DB `state` was `'active'` or `'needs_review'`.
3. In `inject.js`, `selectFacts(db, "where is the db?")` expands `"db"` to `"database"` and matches Fact #2, while `buildPromptInjection(db, "when did this happen?")` returns `null` (0 facts injected); any selected fact with `stale.length > 0` renders with `(NEEDS REVIEW — changed since recorded: ...)` even if its SQLite `state` column was still `'active'`.

## Implementation plan

1. In `facts.js`:
   - In `fingerprint(filePath)`: check `const stat = fs.statSync(filePath); if (!stat.isFile()) throw new Error('not a regular file');` before hashing.
   - In `checkEvidence(factId)`: add `unverified: 0` to `status`. When `!row.sha256`, increment `status.unverified++` instead of `status.missing++` so un-fingerprinted provenance paths match the documented contract (*"simply cannot contribute to verification"*). Keep `status.missing++` and `status.changedPaths.push(row.path)` when `row.sha256` is present and `fs.statSync(row.path)` fails.
   - In `verify(ids)`: compute `const ttlExpired = Boolean(fact.ttl_days && fact.last_verified_at && (now - fact.last_verified_at) / 86400000 > fact.ttl_days);` and `const drifted = status.changed > 0 || status.missing > 0 || ttlExpired;`. Only update `last_verified_at = now` when `!drifted && status.checked > 0`. Include `ttlExpired` in the returned verification objects.
   - In `FactStore.update(id, changes)`:
     - Validate `if (changes.kind !== undefined && !VALID_KINDS.includes(changes.kind)) throw new Error(...)`.
     - Validate non-empty `title` and `body` when provided, and validate `confidence` (`typeof confidence === 'number' && confidence >= 0 && confidence <= 1`) in both `record()` and `update()`.
     - Validate that `supersedes` (when provided in `record()`) references an existing fact ID in `facts`.
     - If `Array.isArray(changes.evidence)`, replace or re-attach the evidence list for `id`.
     - Call `this.reaffirm(id)` whenever `changes.state === 'active'` (removing the `&& fact.state !== 'active'` guard so an active fact whose evidence drifted on disk is re-baselined when explicitly reaffirmed).
   - In `FactStore.factsForPaths(paths, baseDir)`: resolve each input path with `baseDir ? path.resolve(baseDir, p) : path.resolve(p)` and normalize via `canonicalKey` (handling symlinks and platform case) before matching against stored evidence paths.
   - Add JSDoc (`@typedef`, `@param`, `@returns`) to `FactStore` and exported helpers.
2. In `inject.js`:
   - Define a compact `PROMPT_STOPWORDS` set for common 3+ letter English function words not in `LEXICON.fillers` (`what`, `when`, `where`, `which`, `while`, `who`, `whom`, `whose`, `why`, `how`, `this`, `that`, `these`, `those`, `there`, `their`, `theirs`, `them`, `they`, `then`, `than`, `from`, `into`, `onto`, `upon`, `over`, `under`, `about`, `after`, `during`, `have`, `has`, `had`, `having`, `been`, `being`, `were`, `was`, `are`, `can`, `will`, `does`, `did`, `done`, `some`, `such`, `only`, `also`, `more`, `most`, `other`, `each`, `every`, `both`, `all`, `any`, `for`, `not`, `but`, `nor`, `yet`, `our`, `out`, `off`, `own`, `same`, `too`).
   - Update `isMeaningful(term)`: check `if (PROMPT_STOPWORDS.has(term.toLowerCase())) return false;`. Expand `term` via `expand(term)` before checking alphanumeric length (`>= 3`), so 2-letter lexicon abbreviations (`db`, `fn`, `tx`, `mw`) survive filtering and expand into full domain terms in `termForms()`.
   - In `renderInjection(selected)`:
     - Flag the line with `(NEEDS REVIEW — changed since recorded: ${stale.join(', ')})` when `(fact.state === 'needs_review' || stale.length > 0) && stale.length`.
     - If `line.length > budget`, `continue` instead of `break` so a shorter subsequent fact can still fit.
     - If no fact lines were added (`lines.length === 1`), return `null` instead of returning a header and footer with zero facts.
   - Add JSDoc (`@typedef`, `@param`, `@returns`) to exported functions.
3. In `test/test-facts.js` and `test/test-inject.js`:
   - Add tests for un-fingerprinted provenance (`sha256: null`) vs. deleted evidence files, `ttl_days` expiry in `verify()`, `update({ state: 'active' })` re-baselining when DB state is already `'active'`, `update()` validation on invalid `kind`, `"where is the db?"` recall, `"when did this happen?"` silence, and `renderInjection` flagging active facts with `stale.length > 0`.

## Verification

- Run `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-facts.js` and `test/test-inject.js`; expect all assertions to pass (`0 failed`).

## Implementation result (2026-10-20)

- `facts.js` now separates unverified provenance from missing fingerprinted evidence, flags expired TTLs without renewing them, re-baselines on explicit activation, validates fact updates, replaces local evidence lists, and resolves touched paths with workspace canonical keys.
- `inject.js` filters common function words, expands short lexicon terms before length filtering, flags selected facts with changed evidence, and skips oversized lines while retaining later facts that fit.
- Regression coverage was added to `test/test-facts.js` and `test/test-inject.js`. The cross-workspace fixture now marks its temporary project roots explicitly so a parent `/tmp/.git` cannot capture them.
- Bundled Node 22 full suite passed: workspace 32, facts 67, injection 34, MCP 33, hook 29; all with 0 failures. The suite required execution outside the sandbox because its child Node processes received `EPERM` inside it.

## Open decisions and sources

None.
