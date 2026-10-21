# Task 01 counter-plan 2 — SaaS-style boundary review

Task: [Counter-plan 2, D1–D3](01-session-start-workspace-symbol-injection.counter-plan-2.md).
Review date: 2026-10-21.
Implementation baseline: `4b7fb8ea983372be53011eb3365e0ba00d5bcd3a`.
Reviewed completion and HEAD: `4b2436e8e62cba882237d8e2431ab7c4f95d3f6a`.

## Findings

### B1 — P2: read APIs discard unchecked verification and present the fact as current

Locations: `mcp.js:614`, `explore-server.js:336`, `explore-server.js:649`, `explore-server.js:668`; consumer: `explore-ui/src/features/knowledge/KnowledgeBoard.tsx:274,284`.

The D1 hook fix works. The broader API boundary still loses the same verification information: MCP's `search_facts` renderer retains `changedPaths` but drops `EvidenceStatus.unchecked`. Explore's `ensureVerified` discards verification outcomes, and its fact DTO compares anchor signatures only against cached AST rows. A failed parser refresh therefore returns an obsolete fact as `active`, with `trust: 1`, no changed files, and an HTTP anchor marked `current: true`. There is no metadata distinguishing a successful current-source check from one that could not run.

This is a **pre-existing boundary defect and a spec gap**, not a regression introduced by the six-file D1–D3 diff. Counter-plan 2 explicitly limited D1 to standing, prompt, and extra Antigravity injection. The requested `sdd-review-saas` workflow traces API callers as well, and the user's standing review requirement covers supported defects outside the original implementation. That wider review is why this additional correction is recorded rather than treating the passing hook test as complete coverage of fact consumers.

Reproduction using a disposable `CAIPIRA_HOME` and an explicit workspace marker:

1. Index `api.js` containing `export function api(value) { return value; }`.
2. Record an anchored constraint, summary `Api takes one argument.`, using a rooted `FactStore`; remove only local file fingerprints with the supported `update(id, { evidence: [] })` call. The symbol anchor remains.
3. Change the source to `api(value, extra)` and point `CAIPIRA_AST_BIN` at a nonexistent executable.
4. Invoke the actual Codex `SessionStart`, initialize the real MCP server and call `search_facts` with `include_stale: false`, then request the real HTTP endpoint `/api/facts?workspace=<id>&q=api+argument+count&refresh=1`.

Observed hook output, correctly repaired by D1:

```text
- [constraint#1] Api takes one argument. (NEEDS REVIEW — symbol evidence could not be checked)
```

Observed MCP result, omitting ordinary title/body/timestamp fields here:

```json
{"id":1,"state":"active","trust":1,"stale_files":[]}
```

Observed HTTP result, likewise reduced to the relevant fields:

```json
{"id":1,"state":"active","trust":1,"drifted":false,"evidence":[],"symbols":[{"path":"api.js","qualifiedName":"api","current":true}]}
```

Both API calls succeeded. The actual source now takes two arguments. No fact or timestamp was deliberately corrupted. MCP clients have no per-fact warning, and the knowledge board's inspected rendering logic shows 100% trust with no review badge when given the HTTP result. That UI consequence is established by source inspection; no browser/DOM execution is claimed.

Correction: preserve unavailable-verification information in the MCP and HTTP fact response contracts and in the knowledge board's typed consumer. Distinguish unchecked evidence from proven drift, persisted confidence, and equality with a cached index. Do not change the stored fact state, manufacture stale paths, or call a cached match a successful source check. Scope transient verification outcomes by workspace database and fact ID. Use additive response metadata so existing fields retain their meaning, with a clear UI indication that current evidence could not be checked.

## Criterion and scope review

| Criterion | Result |
| --- | --- |
| D1: standing/prompt/Antigravity warning | Implemented: `selectFacts` carries `unchecked`; `factLine` formats it; startup passes unchecked verification IDs into the standing block. The independently executed hook scenario now emits the exact warning. Existing recorded tests cover prompt and Antigravity extra recall, no invented drift/timestamp change, and healthy signature drift. |
| D2: canonical file-evidence locality | Implemented: existing evidence uses its real path and canonical root, missing evidence uses a lexical fallback, and path adapters handle drive/case comparisons. An independent two-alias/inside-outside probe passes; recorded tests cover ordering, deleted evidence, sibling prefixes, and Windows path rules. |
| D3: shared BM25 weights | Implemented: `facts.js` owns named frozen title/summary/body weights and one static SQL expression; both queries bind those weights before their existing match/state/limit parameters. No untrusted SQL interpolation is added. Recorded ranking-parity checks retain the former values and order. |

The actual diff changes only README, `facts.js`, `inject.js`, the universal hook, and two relevant test suites. All are authorized by counter-plan 2; there are no unexplained implementation paths to revert. Rust, schema/migrations, installer registrations, runtime wrappers, and UI code are unchanged. README changes document the resulting behavior. Both checkpoint messages are free of co-author trailers, and the baseline remains reachable.

No YAML project, constitution, or domain definitions are present. This remains a local utility governed by README and the supplied task contracts; no hosted authorization or tenant model was invented for this review. Existing per-workspace SQLite routing and canonical registry identity remain unchanged. The API defect concerns truthfulness of verification metadata, not observed cross-workspace access. No unresolved required spec field was used by the implementation.

No SDD engine run ID/scope report accompanies the work, and this session exposes no `get_run_report` tool. Scope was checked directly against Git. The additional MCP/HTTP/UI correction is recorded explicitly as a spec gap in [counter-plan 3](01-session-start-workspace-symbol-injection.counter-plan-3.md), rather than retroactively expanding D1's stated acceptance criteria.

## Checks and limits

- Caipira's verified implementation status #50 records all eight bundled Node 22 suites passing, 706 assertions total, at this completion. Those settled results were reused rather than rerunning them solely to reconfirm the implementer's checks. Rust is unchanged; its previously verified tests/format/Clippy results remain applicable.
- Independently executed `node --check` with the bundled Node 22 for `facts.js`, `inject.js`, and `hooks/universal-hook.js`: all pass.
- Independently executed isolated integration probe: actual Codex hook, real initialized MCP stdio server, real localhost Explore HTTP server, and canonical alias/outside checks. The hook and path checks pass; the MCP/HTTP outputs reproduce B1. Subprocesses and the HTTP server were closed and temporary stores removed.
- The first integration attempt was invalidated by sandbox `spawnSync EPERM`; the authorized run outside the sandbox succeeded. No live memory database was a test target.
- Reviewed the TypeScript response schema and React knowledge-board rendering without modifying them. No UI build, UI tests, or live browser check was needed to validate this JavaScript-only diff; those checks are required for the new consumer repair. Native Windows/macOS, production/load behavior, and live coding-client integration remain unverified. Root JavaScript lint/format commands are unconfigured.

## Disposition

**D1–D3 pass, but the broader API review requires changes for B1.** No approval tag is created for `4b2436e`. Only this review and its separate counter-plan are written; no implementation, dependency, migration, deployment, release, or push is performed.
