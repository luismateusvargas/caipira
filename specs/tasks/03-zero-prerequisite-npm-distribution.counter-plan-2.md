# Zero-prerequisite npm distribution — counter-plan 2

Original task spec: [03-zero-prerequisite-npm-distribution.md](03-zero-prerequisite-npm-distribution.md)
Previous counter-plan: [03-zero-prerequisite-npm-distribution.counter-plan.md](03-zero-prerequisite-npm-distribution.counter-plan.md)
Review evidence: independent review, 2026-10-22. The probes below used fake `HOME` and npm prefixes. Every suite or probe that starts an installer ran inside a capped scope (`systemd-run --user --scope -p TasksMax=768 -p MemoryMax=6G -p MemorySwapMax=0`).
Status: ready

Reviewed baseline: `3b862b01985c9e6a5e862cb21ab088696c75b522` (counter-plan checkpoint).
Reviewed state: `7cc1038` plus uncommitted changes to `install.js`, `runtime.js`, the tests and the counter-plan. There is no completion commit and no approval tag.

## What passes

- **Full suite on checksum-verified Node 22.23.4**, with `NODE_PATH` pointing at a `node_modules` installed from `runtime/package-lock.json`: 10 suites, 1,078 checks, 0 failures. Peak usage was 44 tasks and 176 MiB.
- **The documented 22.20.0 command:** all suites pass. `test-install` reports 203 passed and 6 skipped launcher checks (see the OOM section).
- **Hygiene:** `sh -n caipira.sh`, `git diff --check`, and the workflow YAML parse are clean. `npm pack --dry-run` lists `runtime/package.json` and `runtime/package-lock.json`, and the root package has no runtime dependencies.
- **Staged tarball:** 32 files, 20.4 MB, with the UI, the model and a host AST binary. `npm i -g` added one package and blocked or built nothing under Node 26.10.0 / npm 12.2.0 and under Node 22.20.0 / npm 10.9.3.
- **With Z1 applied to scratch copies only:** these criteria pass end to end:
  - 1: registrations name `<home>/.caipira/node22/node-v22.23.4-linux-x64/bin/node`.
  - 2: the second install reuses the runtime and `node_modules` (same inode and mtime). An upgrade from a `node-v22.20.0` deployment re-registers on 22.23.4, removes 22.20.0, and its hook exits 0.
  - 3: the hook and `status` work with no `node` on `PATH`.
  - 4: the launcher and the npm bin exit 1 with "run caipira install".
  - 5: the checkout install leaves no `node22` or `node_modules` in the checkout, and the hook works after the checkout moves.
  - 6: `mode lite` and `status` act on the deployment, and `doctor` reports deployment paths.
  - 7: a changed lockfile replaces `node_modules`.
  - 8: a deployment rerun without UI or AST exits 0 with warnings.
  - 9: a healthy `doctor` reports v22.23.4.
  - 10: `install --clients codex` makes `doctor` print `[skip] Claude Code not selected` and exit 0. A plain install then checks both clients.

## OOM incident (gotchas #98 and #100): resolved and verified

- **Cause:** a POSIX test fixture replaced the deployed Node with a `#!/bin/sh` wrapper that faked `--version`. `install()` re-executes whenever `realPath(process.execPath) !== realPath(deployedRuntime.node)`, and a wrapper never matches, so every child re-executed again.
- **Kernel evidence:** the kernel OOM dumps on 2026-10-22 show this chain of synchronous installers: 27,240 `node` task entries at 16:26–16:27 (previous boot) and 2,172 at 16:37:48 (current boot).
- **Reproduced in a capped scope:**
  - The `HEAD` (`7cc1038`) installer behind such a wrapper nested 22 installers until `TasksMax` stopped it, and was then killed by the timeout.
  - The current installer re-executes once. The child sees `CAIPIRA_REEXEC_GUARD=1`, prints "recursive re-exec loop detected", and exits 1.
- **Fixes already present (kept):**
  - The `installFixture` symlink plus its real-path assertion (`test/test-install.js:274-283`).
  - The guard in `install()` (`install.js:1256-1270`).
  - The VM regression check "re-exec guard stops a mismatched runtime before spawning again".
- **Fix added in this review:** `test-install.js` routes the six checks that execute `caipira.sh` through `launcherCheck`. They run only when the suite's own interpreter is Node 22.23.4; otherwise they print a visible `skip` line. On 22.20.0 those checks used to fail, and that failure is what prompted the wrapper. The npm-CLI half of the mixed mode/status check now runs on any interpreter.
- **Kept as is:** `test/test-explore.js:611-615` still uses a `--version` wrapper for `caipira.sh explore`. That path starts `explore-server.js` directly and never reaches `install()`, and the guard limits any re-exec to one child.

## Confirmed failures

**X9 (high, blocker): every real install entry point fails after provisioning with `Cannot find module 'better-sqlite3'`.**
- **Code path:** `buildAstEngine` (`install.js:311`) requires `./ast`. `ast.js:15` requires `./workspace`, and `workspace.js:16` requires `better-sqlite3`, all resolved from the package or checkout directory. Since Y1 the npm package has no dependencies, and a checkout has no root `node_modules`. Dependencies exist only under `<CAIPIRA_HOME>/node_modules`.
- **Triggers:**
  - The packed tarball installed with `npm i -g` under Node 26.10.0 / npm 12.2.0 or Node 22.20.0 / npm 10.9.3, followed by `caipira install`.
  - `node bin/caipira-cli.js install` from a copy of the checkout on system Node 26.
- **Observed:** Node 22.23.4 is provisioned, `npm ci` reports "added 83 packages", the model is copied, then `[FAIL] install — Cannot find module 'better-sqlite3'` and exit 1. No client is registered.
- **Expected:** acceptance criteria 1 and 5, and the README install commands, exit 0.
- **Why the tests miss it:**
  - `installFixture` symlinks `node_modules` into every package source (`test/test-install.js:274-283`).
  - Every fixture inherits the runner's `NODE_PATH`.
  - The workflow sets `NODE_PATH` too.
  - So check 4b ("npm install works without a preinstalled deployment Node or dependencies") passes.

**X10 (low; regression of Task 02 single consent): the consent prompt for an undetected client appears twice.**
- **Code path:** `install()` calls `selectClients` on the host Node, then re-executes, and the child calls it again on the same terminal (`install.js:1245`, `:1263`).
- **Trigger:** under a pseudo-terminal (`script`), `caipira install --clients antigravity` with Antigravity undetected and no `--accept-risk`.
- **Observed:** `Proceed? [y/N]` was printed twice. Every bootstrap install also repeats the `[skip]` lines and "Installing Caipira".
- **Impact:** answering N at the second prompt exits 1 after the parent has already provisioned `node22`.

**X11 (low): `replaceDependencyDirectory` (`install.js:252-282`) is dead code.** Nothing calls it. Y1 asked to remove the in-process replace-and-validate code.

## Surgical corrections

**Z1 → X9.**
- Move `platformBinaryName` and its supported-target set from `ast.js` into the dependency-free `runtime.js`. `ast.js` imports and re-exports it, so `require('./ast').platformBinaryName` and its tests keep working.
- `buildAstEngine` uses `RUNTIME.platformBinaryName()` and `path.join(ROOT, 'rust', 'caipira-ast')`, and no longer requires `./ast`.
- No other install-path step may load a module that needs runtime dependencies from `ROOT`.

**Z2 → X10.**
- `selectClients` reports whether interactive consent was given.
- When it was, `install()` appends `--accept-risk` to the re-exec arguments if they don't already include it, so the child never prompts.
- Consent still comes before any write. The selection rules and the non-interactive refusal are unchanged.

**Z3 → X11.** Delete `replaceDependencyDirectory`.

**Z4 → X9 test gap.**
- In check 4b (npm package) and the checkout-bootstrap fixture (`checkoutBootstrap`, section 5a), remove the source `node_modules` symlink and delete `NODE_PATH` from that install's environment.
- Leave other fixtures unchanged; their `doctor` and `status` runs start the source `install.js` and need it.
- Keep `launcherCheck`. Never reintroduce a version-faking wrapper at a path that `install()` provisions.

## Acceptance and verification (Linux)

Run every suite and probe that starts an installer inside the capped scope above.

1. **Z4 first, against current code.** The two adjusted fixtures fail with `Cannot find module 'better-sqlite3'`. After Z1 they pass.
2. **Z1 end to end:**
   - Use a packed tarball (UI, model, host AST binary) with fake `HOME` and prefix, under system Node 26 / npm 12 and under Node 22.20.0 / npm 10.
   - `caipira install` exits 0, and registrations name `node-v22.23.4-linux-x64/bin/node`.
   - The registered SessionStart hook exits 0 with no `node` on `PATH`.
   - `node bin/caipira-cli.js install` from a copy of the checkout on Node 26 also exits 0.
3. **Z2:** under `script`, `install --clients antigravity` prints exactly one `Proceed? [y/N]`. Answering N exits 1 and leaves no `node22` and no client configuration. `--accept-risk` and non-TTY refusal behave as before.
4. **Z3:** `grep replaceDependencyDirectory install.js` finds nothing.
5. **Suite and hygiene:**
   - The full suite on checksum-verified Node 22.23.4 with `NODE_PATH` from `runtime/package-lock.json` passes with no skips.
   - The documented 22.20.0 command passes, with only the six `launcherCheck` skips.
   - `sh -n caipira.sh` and `git diff --check` are clean.
6. **Still open from counter-plan 1:** criterion 1 with Node 24 / npm 11 and Node 24 / npm 12, and criterion 11's static musl `linux-x64` AST build (`ldd` reports not a dynamic executable).

Completion means X9–X11 are fixed, these checks pass, and an independent review follows. Follow the local baseline and completion checkpoints. Do not push, publish, release, bump versions, or add co-author trailers.

## Blockers

- None for Z1–Z4.
- Criterion 11's static musl build needs `cross` (with Docker or Podman) or a musl C toolchain. This host has the Rust `x86_64-unknown-linux-musl` target but neither `cross` nor `musl-gcc`.
- **Note:** reinstalling the real `~/.caipira` removes `node-v22.20.0` (`removeSupersededRuntimes`). After that, the documented test command must use `~/.caipira/node22/node-v22.23.4-linux-x64/bin/node`.
