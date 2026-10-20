# Fix prose expansion round-tripping and consolidate dual-form FTS query builders

Status: done
Project rules: specs/project.md#constitution
Target files: compress.js, store.js, facts.js, inject.js, test/test-facts.js, test/test-inject.js

## Outcome and boundary

Make `compress()` and `expand()` in `compress.js` round-trip slash-containing lexicon abbreviations (`"w/"`, `"b/c"`, `"w/o"`), handle invalid compression intensities safely, and consolidate the duplicated dual-form FTS query construction helpers (`termForms`, `ftsQuote`, `buildAndMatch`, `buildOrMatch`) from `store.js`, `facts.js`, and `inject.js` into `compress.js`. Database schema, workspace routing, and fact trust scoring stay outside scope.

## Acceptance criteria

1. `expand(compress("authentication with database because without configuration", { intensity: "full" }))` returns `"authentication with database because without configuration"`, and `termForms("w/")`, `termForms("b/c")`, and `termForms("w/o")` each include both the abbreviated and expanded forms (`"with"`, `"because"`, `"without"`).
2. Calling `compress("please check the database", { intensity: "invalid" })` or `compress(null)` does not throw; unknown intensities fall back to `"full"`, and non-string/empty inputs return `""`.
3. `store.js`, `facts.js`, and `inject.js` import `termForms`, `ftsQuote`, `buildAndMatch`, and `buildOrMatch` from `compress.js` without local copies, and existing + new FTS query tests in `test/test-facts.js` and `test/test-inject.js` pass.

## Implementation plan

1. In `compress.js`:
   - Deduplicate `escapeRe` and `escapeRe2` into a single `escapeRe(s)` helper.
   - Update `RULES` (`kind: "path"`) so a slash path requires either a leading path prefix (`./`, `../`, `~/`, `[A-Z]:\`), start-of-string/whitespace/quoting before `/`, or at least two path segments, preventing single-letter slash abbreviations (`b/c`, `w/o`, `w/`) inside prose from being tokenized as `preserved: true` paths.
   - Clone or instantiate per-call `RegExp` instances inside `tokenize(input)` instead of mutating shared module-level `rule.re.lastIndex`.
   - Fix `expand(input)` regex boundaries: replace the trailing `\b` with `(?=$|[^\p{L}\p{N}])` (and leading `(?<=^|[^\p{L}\p{N}])` with Unicode property escapes) so keys ending in non-word characters like `"w/"` match before whitespace or punctuation.
   - Normalize `intensity` in `compress()` and `compressProse()` (`const validIntensity = LEXICON.fillers[intensity] ? intensity : 'full'`) and coerce non-string inputs safely (`if (typeof input !== 'string' || !input) return '';`).
   - Move `SEARCH_INTENSITIES`, `hasSearchableChars`, `termForms`, `queryForms`, `ftsQuote`, `buildAndMatch` (formerly `sanitizeMatch` in `store.js` and `buildMatch` in `facts.js`), and `buildOrMatch` (from `inject.js`) into `compress.js` and export them alongside `LEXICON`.
   - Add concise JSDoc (`@typedef`, `@param`, `@returns`) to all exported functions in `compress.js`.
2. In `store.js`, `facts.js`, and `inject.js`:
   - Remove the duplicated `SEARCH_INTENSITIES`, `termForms`, `queryForms`, `ftsQuote`, `sanitizeMatch`/`buildMatch`, and `buildOrMatch` definitions and import them from `./compress`.
   - Re-export `buildMatch` (aliased to `buildAndMatch`) and `termForms` from `facts.js` so existing callers (`inject.js`, `test/test-facts.js`) preserve their public contract.
3. In `test/test-facts.js` and `test/test-inject.js`:
   - Add assertions verifying `expand()` round-tripping of `"w/"`, `"b/c"`, and `"w/o"`, `termForms()` expansion of slash abbreviations, and safe fallback on unknown `intensity` in `compress()`.

## Verification

- Run `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-facts.js` and `test/test-inject.js`; expect all existing and new assertions to pass (`0 failed`).

## Open decisions and sources

None.
