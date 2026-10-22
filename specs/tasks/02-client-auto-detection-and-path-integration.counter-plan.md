# Client auto-detection and PATH integration — counter-plan

Original task spec: [02-client-auto-detection-and-path-integration.md](02-client-auto-detection-and-path-integration.md)
Review evidence: independent review, 2026-10-22 (probes below).
Status: implemented — pending independent review

Reviewed baseline: `d28c6a39231713238c87974751af518f308e4dbe`.
Reviewed completion: `a9efe480f71795c3bf68ea4696889c5e93fe9e92`.

All nine suites pass at the completion commit (912 checks, 0 failures).

These parts work in real runs:
- Detection, aliases, and refusal before any write.
- The `[y/N]` prompt under a real terminal: `n` exits 1 with no config written, `y` installs.
- Runtime sync and the explorer starting in the invoking directory.

The install fixtures pre-provision `node22/`, `node_modules/` and `models/` in **both** the checkout and the deployment. They also run the launcher with `CAIPIRA_HOME` inherited from the test environment. Both choices hide H1 and H2.

## Confirmed failures

**H1 (medium; criteria 4 and 5, and the spec's isolated-`CAIPIRA_HOME` manual check): installing into a deployment without prerequisites reports success but registers commands that cannot run.**
Since this task, every registration targets the deployment (`runtimePaths()`, `install.js:144-150`). `install()` (`install.js:866-883`) never checks that the deployment holds the Node 22 runtime and native dependencies those commands need.
- Trigger: use a scratch checkout with `node22/` and `node_modules/` provisioned, an empty `CAIPIRA_HOME=<home>/.caipira`, a fake `HOME` containing `.claude/`, and run `install.js install`.
- Observed: exit 0, with every step `[ok]` including "complete runtime synchronized", "launcher installed", "MCP server registered" and "hooks registered".
  - `.claude.json` names `<home>/.caipira/node22/node-v22.20.0-linux-x64/bin/node`, which does not exist.
  - The registered SessionStart hook command exits **127** ("No such file or directory").
  - `caipira status` and `caipira explore` through the PATH launcher exit 1 with "bundled Node 22 runtime not found".
  - `doctor` run from the checkout still reports `[ok] bundled Node 22`, because it checks the checkout's runtime.
- Before this task, registrations pointed at the checkout runtime that ran the install, so the same scenario produced working commands.
- Expected: when installing from a checkout, an unprovisioned deployment is refused before any deployment, launcher or client-configuration write, with exit 1 and a message naming what is missing.

**H2 (medium; regression): with a custom `CAIPIRA_HOME`, the MCP server reads a different database than the hooks and the launcher.**
This task added `CAIPIRA_HOME: HOME_DIR` to the MCP environment at `install.js:387` (Claude Code), `install.js:437` (Codex) and `install.js:467` (Antigravity). Hook commands (`install.js:182`, `:430`, `:483`) and the PATH launcher set no `CAIPIRA_HOME`, and `test/test-install.js` §4 requires that the launchers never set it. At the baseline, no registration set `CAIPIRA_HOME`, so every entry point used the same default.
- Trigger: install with `CAIPIRA_HOME=<custom>` into a provisioned deployment, with Claude detected.
- Run the registered UserPromptSubmit hook command (no `CAIPIRA_HOME` in its environment, as a new client session would): it creates `<home>/.caipira/database/{master.db,ws2-….db}`. Nothing is written under `<custom>/database`.
- Run the registered MCP command and env, then `tools/call list_sessions` for the same workspace: it returns `[]`.
- Run `caipira status` through the launcher: it reports `workspaces: 1, sessions: 1` from `<home>/.caipira`.
- Impact: MCP search, fact recording and drift checks run against a database that hooks never populate, and hook injection never sees facts recorded through MCP.
- Expected: every registered entry point and the launcher resolve the same data root.

**H3 (low; criterion 4): reinstalling puts an extra executable command on the user's PATH.**
`registerPath()` (`install.js:363`) writes the launcher with `writeTextAtomic`, which copies an existing file to `<file>.caipira-backup` first. `copyFileSync` keeps the executable mode.
- Trigger: install twice into the same fake `HOME`.
- Observed: `~/.local/bin` contains `caipira` and `caipira.caipira-backup`, both `-rwxr-xr-x`. `caipira.caipira-backup status` runs Caipira from PATH.
- Expected: `~/.local/bin` gains only `caipira`.

**H4 (low; user rule: named operational limits): the Windows PATH adapter's 15-second limit is a plain number.**
`install.js:355` passes `timeout: 15000` to the PowerShell call.

## Surgical corrections

**K1 → H1.** In `install()`, after `selectClients` succeeds and before any other step, and only when `realPath(HOME_DIR) !== realPath(ROOT)`, check two things:
- the deployment interpreter `runtimePaths().node` exists, and
- `<HOME_DIR>/node_modules/better-sqlite3/package.json` exists.

If either is missing, print what is missing and that Node 22 and the dependencies must be provisioned in the deployment first. Then set exit code 1 and return. No deployment, `.runtime-*`, launcher or client-configuration write may happen.

Keep these unchanged: installs from inside the deployment (`ROOT === HOME_DIR`), the optional UI/AST handling, the models, and the consent flow. Do not copy or download prerequisites; that is Task 03.

**K2 → H2.** Remove `CAIPIRA_HOME` from the three MCP registration environments and keep `CAIPIRA_MODEL_PATH` as it is. All entry points then resolve their data root from their own environment, as at the baseline.
- Update the README `CAIPIRA_HOME` row: install deploys the runtime and points the launcher at that directory. Hooks, MCP and the launcher read `CAIPIRA_HOME` from their own environment (default `~/.caipira`); install does not register it.
- Update the fixture assertion that expects the MCP `env.CAIPIRA_HOME`.
- Do not add `CAIPIRA_HOME` to launchers or hook commands. Doing so would change `hooks/universal-hook.js` or the launcher contract, which is outside these corrections.

**K3 → H3.** Write the launcher through its own temporary file and rename it into place, without the backup copy. Keep the `#!/bin/sh` launcher content, its quoting, `0o755`, and the PATH recommendation unchanged. Client configuration files keep their `.caipira-backup` behavior.

**K4 → H4.** Name the PowerShell limit (for example `PATH_REGISTRY_TIMEOUT_MS = 15000`) and use it at the call site. Keep the value.

## Acceptance and verification

1. **K1.**
   - With a fixture whose deployment has no `node22/` or `node_modules/` and a `.claude/` marker, `install` exits 1 and names the missing interpreter and dependency.
   - The deployment contains no runtime files and no `.runtime-*` directory, `~/.local/bin/caipira` does not exist, and `.claude.json` and `.claude/settings.json` are unchanged.
   - Fully provisioned fixtures and the `CAIPIRA_HOME = checkout` case still install.
2. **K2.**
   - After a custom-`CAIPIRA_HOME` fixture install, none of the three MCP registrations contains `CAIPIRA_HOME`.
   - With no `CAIPIRA_HOME` in the parent environment, run the registered UserPromptSubmit hook command with a session ID and the workspace `cwd`. Then run the registered MCP command and env, and call `list_sessions` for that `cwd`: it returns that session.
   - `caipira status` through the launcher counts the same session.
3. **K3.** Install twice into one fixture. `~/.local/bin` then contains only `caipira`, which is executable, has the expected content, and runs `status` from another directory.
4. **K4.** The Windows adapter test still observes a 15-second PowerShell limit, and `install.js` contains no plain `15000`.

Then run the full suite after the final edit:

```sh
TMPDIR=/var/tmp NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
```

Also run `sh -n caipira.sh`. Rust and UI checks are not needed. Completion means H1–H4 are fixed and these checks pass, followed by an independent review. Follow the local baseline/completion checkpoints. Do not push, release, bump versions, or add co-author trailers.

## Blockers

None.

## Implementation evidence

- Baseline checkpoint: `956481061a7f47368da3064bfe6c7f5a3ef14a7c`.
- K1: after client selection/consent and before any install step, checkout installs check the deployment interpreter and `better-sqlite3/package.json`. Missing prerequisites are named and installation returns exit 1. Tests cover both missing, only Node missing, and only dependencies missing, with no runtime/staging/log/launcher writes and byte-for-byte preservation of existing Claude configuration. Provisioned installs and same-home installs continue to pass.
- K2: all three MCP environments retain only `CAIPIRA_MODEL_PATH`. The README distinguishes the install target from each process's inherited data root. With a custom deployment but no `CAIPIRA_HOME` in the new parent environment, the actual registered UserPromptSubmit command writes a session, the actual registered MCP command returns it through `list_sessions`, and PATH `status` counts the same session. No database is created in the custom install directory by these processes.
- K3: the POSIX launcher uses a separate temporary write, chmod to `0o755`, and rename, with temporary cleanup and no backup. Repeated installs leave only `caipira` in the user bin directory; its content/mode and execution from another directory pass. Client configuration backups are unchanged.
- K4: `PATH_REGISTRY_TIMEOUT_MS = 15_000` names the existing Windows limit. The adapter test observes 15000 ms and the installer has no plain `15000` literal.
- Before the runtime corrections, the expanded installation suite reported **85 passed, 16 failed**, reproducing H1–H4. After correction it reported **101 passed, 0 failed**.
- The first full run exposed an existing journal fixture that deliberately hid every dependency marker, including the deployment marker now required by K1. Updated that fixture to provide unused prerequisite markers and hide only the checkout dependency, preserving its synthetic command failure and all journal assertions. The journal suite then passed **20/0**.
- Final verification: `TMPDIR=/var/tmp NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js` passed all nine suites: **930 checks, 0 failures** (20/33/87/100/90/167/101/141/191). `git diff --check` and `sh -n caipira.sh` passed. Successful integration runs used approved execution outside the sandbox and isolated temporary homes.
- Changed paths: `install.js`, `README.md`, `test/test-install.js`, `test/test-errors.js`, and this counter-plan. The journal fixture is the additional affected test path; no implementation deviations from K1–K4. Task 03 remains untouched and untracked.
- Limits: Linux with bundled Node 22 verified. Native Windows/macOS, real Windows registry writes, and a live user installation upgrade remain unverified. Optional assets, model handling, consent, hook payloads and launcher environment contracts remain unchanged. Independent review is pending; no approval tag, version bump, release or push.
