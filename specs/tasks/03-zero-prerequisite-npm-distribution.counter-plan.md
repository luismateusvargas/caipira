# Zero-prerequisite npm distribution — counter-plan

Original task spec: [03-zero-prerequisite-npm-distribution.md](03-zero-prerequisite-npm-distribution.md)
Review evidence: independent review, 2026-10-22 (probes below), plus the user's requirement decisions of the same date.
Status: ready

Reviewed baseline: `255159fd002072c32ce4ef5283ad03d7fb9e97d2`.
Reviewed completion: `29b43138894237b1f39236a637353faf97376614`.

These parts work in real runs:
- A packed tarball (29 files, 19.8 MB, with the UI, model and a real `linux-x64` AST binary) installs with `npm i -g` under Node 22 / npm 10. `caipira install` from the npm bin then completes with no cargo, frontend build or model download, and the registered hook exits 0.
- All nine suites pass (1,021 checks, 0 failures). They also pass with `NODE_PATH` pointed at the pinned `better-sqlite3` 12.9.0. `git diff --check`, `sh -n caipira.sh`, `node --check` and the workflow YAML parse are clean, and the commits carry no co-author trailer.

Probes ran under `scratchpad/t3` with fake homes and prefixes. Besides the bundled Node 22, they used Node 24.22.1 (bundled npm 11.19.1, downloaded with a checksum check) and the system Node 26.10.0 with npm 12.2.0.

## Requirement change (user decisions, 2026-10-22)

1. **Linux is the verified platform.** macOS, Windows and the release workflow are checked at contract level only, as in Task 02.
2. **Node 22 and SQLite are mandatory.** Every Caipira process runs on a Node 22 runtime that `caipira install` provisions under `<CAIPIRA_HOME>/node22/`: hooks, MCP, launchers and every CLI command. The host Node is used only to start the installer, so upgrading or switching the host Node never affects Caipira.
   - This replaces criterion 1's "Node 20 and 24 use the matching host runtime".
   - It also replaces criterion 4's host-version matrix and its optional `better-sqlite3`.
3. **Every Linux.** Install picks the Node 22 build that matches the host's architecture and C library. The Linux AST binaries are built with `cross` as static musl binaries, so one binary per architecture runs on any Linux.
4. **`better-sqlite3` only needs Node 22 prebuilds.** Its 12.9.0 release has Node 22 (ABI 127) prebuilds for `linux-x64`, `linux-arm64`, `linuxmusl-x64`, `linuxmusl-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64` and `win32-arm64`, checked against the GitHub release assets. Keep the 12.9.0 pin, which passed the full suite.
5. **`--clients` restricts what `doctor` checks.** Clients outside the selection are reported as not selected, never as failures.
6. **Pin Node 22.23.4.** It is the newest 22.x, a security release dated 2026-10-20. It ships npm 10.9.9 and keeps ABI 127, so the 12.9.0 prebuilds still apply. The full suite passed under a downloaded, checksum-verified 22.23.4 against those prebuilds: 1,021 checks, 0 failures.
7. **Linux hosts with no matching Node 22.23.4 build are out of scope.** They are refused for now and will be added if users request them.

## Confirmed failures

**X1 (high): with npm 12, which supports Node 22 and 24, the documented install leaves SQLite without its native addon, and `caipira install` fails with a misleading message.**
npm 12.2.0 (`engines: ^22.22.2 || ^24.15.0 || >=26`) blocks dependency install scripts by default. npm 10 itself prints "New major version of npm available! 10.9.3 -> 12.2.1" during installs, which steers users to it.
- Trigger: Node 24.22.1 with npm 12.2.0, `npm i -g <tarball>`, then `caipira install`.
- Observed: npm warns "3 packages had install scripts blocked …" for `better-sqlite3`, `sharp` and `protobufjs`. The package's `better-sqlite3` has no `build/Release`, and `import('@xenova/transformers')` fails.
- `caipira install` exits 1 with "better-sqlite3 cannot load under Node 24.22.1; use Node 20, 22, or 24" while running Node 24. It has already written `~/.caipira/node_modules` (`install.js:297`) by then.

**X2 (high): switching Node majors and rerunning install always fails.**
`installDependencies` swaps the addon directory and validates it in the same process (`install.js:257-287`, `:272`). glibc returns the already-mapped library for the same path, so Node reports "Module did not self-register".
- Trigger: install under Node 22, then `npm i -g` of the same version under Node 24 and `caipira install`.
- Observed: exit 1, and the swap is rolled back. A minimal probe (`scratchpad/t3/r1-probe.js`) shows the same in-process failure, while a fresh process loads the replacement fine.

**X3 (medium): the launchers' check for bundled Node 22 cannot detect an ABI mismatch.**
`caipira.sh:21` and `caipira.cmd:10` only run `require('better-sqlite3')`. The addon loads lazily (gotcha #64), so the check passes for any ABI.
- Observed: with bundled Node 22 and an addon built for Node 24, the launcher picks v22.20.0 and `caipira status` exits 1 with a NODE_MODULE_VERSION 137/127 error.

**X4 (medium; regression of approved Task 02 behavior): registrations store the Node that ran the installer.**
`NODE_BIN = process.execPath || …` (`install.js:55`; the fallback never runs) and `runtimePaths().node = NODE_BIN` (`:172`). The test at `test/test-install.js:384` now encodes this.
- Observed: a checkout install with its own Node 22 binary registers `<checkout>/node22/…/bin/node`. After the checkout moves, the registered SessionStart hook exits **127**.
- The same mechanism ties hooks and MCP to the host Node's path. Under nvm or Homebrew that path includes the version, so a routine upgrade removes it.

**X5 (medium): commands run through the npm bin act on the npm package directory, not the deployment.**
`bin/caipira-cli.js:39` loads the package's own `install.js` for every command.
- `caipira mode lite` writes `<prefix>/…/caipira/active`, but hooks and MCP read `<deployment>/active`, which is absent, so they keep `full`.
- `status` reports the package's `ultra`.
- `doctor` checks the package's AST binary, UI and dependencies rather than the deployed copies.
- This is also the npm-bin versus `~/.local/bin/caipira` shadowing noted in Task 02.

**X6 (low): dependency upgrades never reach the deployment.**
`copyMissingTree` (`install.js:238-256`) copies only missing files. A simulated `@xenova/transformers` change (version `2.17.99` plus a changed `src/pipelines.js`) left the deployment on `2.17.2` with the old file.

**X7 (low; regression of the optional AST/UI design): a missing optional asset now aborts the install.**
A synced deployment has the scoped `package.json` and no `.git`, so `isNpmDistribution()` (`install.js:182`) treats it as an npm package, and missing assets throw (`:378`, `:415`).
- Trigger A: rerun install from a deployment synced from a checkout without UI or AST. Observed: `[FAIL] install — prebuilt caipira-ast is missing for linux-x64`. The same flow at `346d11a` completed with warnings.
- Trigger B: an npm package with no AST asset for the host (simulated by removing `bin/caipira-ast-linux-x64`). Observed: exit 1 before any client is registered.

**X8 (low): `doctor` labels whatever Node ran it as "bundled Node 22" and that check can never fail.**
`install.js:1061` checks `fs.existsSync(process.execPath)`.

## Surgical corrections

**Y1 → X1, X2, X6 and decisions 2–4: the installer provisions Node 22 and the runtime dependencies itself.**
- **Shared runtime module.** Add one module used by the CLI, `install.js` and `doctor`, with named constants: `NODE_VERSION = '22.23.4'`, the archive table below, and bounded download, extract and dependency-install timeouts.
  - It picks the archive from `process.platform`, `process.arch` and the C library. A glibc host reports `process.report.getReport().header.glibcVersionRuntime`; a musl host does not.
  - Use `.tar.gz` and `.zip` archives, so extraction needs no xz support.

  | Target | File | SHA-256 |
  |---|---|---|
  | linux x64 (glibc) | `node-v22.23.4-linux-x64.tar.gz` | `b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406` |
  | linux arm64 (glibc) | `node-v22.23.4-linux-arm64.tar.gz` | `f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9` |
  | linux x64 musl | `node-v22.23.4-linux-x64-musl.tar.gz` (unofficial-builds.nodejs.org) | `117eae38a39e45d534f1a18c2217709dc0b09835f61689af490137de231eb42c` |
  | darwin arm64 | `node-v22.23.4-darwin-arm64.tar.gz` | `c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428` |
  | darwin x64 | `node-v22.23.4-darwin-x64.tar.gz` | `efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819` |
  | win x64 | `node-v22.23.4-win-x64.zip` | `cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20` |
  | win arm64 | `node-v22.23.4-win-arm64.zip` | `a8b8cd79cbbb3062435f449591d98dd63730bbbf30ce2d7cc3a6376c236cb111` |

  Official files come from `https://nodejs.org/dist/v22.23.4/`, and the musl file from `https://unofficial-builds.nodejs.org/download/release/v22.23.4/`. The checksums are copied from each site's `SHASUMS256.txt`.
- **One version everywhere.** Every hard-coded `22.20.0` follows from `NODE_VERSION` or matches it: `NODE_RELEASE` in `install.js`, `caipira.sh`, `caipira.cmd`, `bin/caipira-cli.js`, the tests and the README. Add a test that fails if any of them disagree.
- **Unsupported hosts.** A host with no entry in the table exits 1, names the supported targets, and writes nothing.
- **Provisioning.** When `<CAIPIRA_HOME>/node22/<release>/` is missing, or its binary does not report `v22.23.4`, install downloads to a temporary file inside `CAIPIRA_HOME`, verifies the SHA-256, extracts into a staging directory and renames it into place.
  - Any failure exits 1 before any client configuration write, names the URL, and leaves an existing runtime untouched.
  - An intact runtime is reused with no network access.
  - **Upgrading an existing deployment:** an install that finds an older `node22/node-v22.*` release provisions 22.23.4, installs the dependencies on it, and points every registration and launcher at it. Only after that does it remove the superseded release directories. If removal fails, it warns and keeps them, for example because a running MCP server holds a file open on Windows.
- **Runtime dependency manifest.**
  - Move the runtime dependencies out of the root `package.json` into `runtime/package.json` and `runtime/package-lock.json`. npm publishes a nested lockfile but drops a root one; this was verified with `npm pack`. `better-sqlite3` 12.9.0 is a regular, required dependency there.
  - The root package keeps `bin` and `files` but declares no runtime dependencies. `npm i -g` then builds nothing on the host, and npm 12 has no script to block. Set `engines.node` to what the bootstrap needs (`>=20`).
  - The deployment's `package.json` and `package-lock.json` are that runtime manifest and lockfile, with the same `version` as the root package; add a test for that.
- **Installing dependencies.** Install runs the bundled runtime's own npm (`npm ci --omit=dev`; Node 22.23.4 ships npm 10.9.9, which runs install scripts) in a staging directory. It swaps `node_modules` into place by rename and keeps the previous copy if anything fails.
  - It skips this step when the deployed lockfile is byte-identical and SQLite opens.
  - After any swap, it checks that `new Database(':memory:')` works under the bundled runtime.
  - This replaces `copyMissingTree` for dependencies and the in-process replace-and-validate code.
- **One runtime for every entry point.** The npm bin, `node install.js install` under any host Node, and the checkout launcher all run the install steps on the provisioned Node 22. Under another runtime, install provisions Node 22 first and then re-runs itself on it.
- **Remove the host-version code.** Task 02's K1 refusal for an unprovisioned deployment is replaced by this provisioning. Remove the host-Node matrix: `SUPPORTED_NODE_MAJORS`, `hasSupportedNodeMajor()` and the CLI's branching on the host major.

**Y2 → X3.** `caipira.sh` and `caipira.cmd` always run the bundled Node 22, as they did before Task 03. When it is missing they exit 1 with "run caipira install". Remove the fallback to Node on PATH.

**Y3 → X4.** `runtimePaths().node` is always the deployment interpreter, `<CAIPIRA_HOME>/node22/<release>/bin/node` (`node.exe` on Windows), and never `process.execPath`. Restore the Task 02 fixture expectation of the deployment `node22` path.

**Y4 → X5.**
- `bin/caipira-cli.js` runs the package's `install.js` (through Y1) only for `install`.
- Every other command runs `<CAIPIRA_HOME>/install.js` on the bundled runtime.
- With no deployment yet, other commands exit 1 with "run caipira install first".

**Y5 → X7.**
- A deployment rerunning its own installer is never treated as the npm package. Y1's runtime manifest in the deployment, or a same-directory check, is enough.
- A package with no AST asset for the host warns that the AST index is unavailable and continues, as checkout installs do.

**Y6 → X8.** `doctor` checks the deployment's Node 22: the path exists, `--version` reports `NODE_VERSION` (`v22.23.4`), and SQLite opens `:memory:`. Otherwise it reports `[FAIL] … run caipira install`.

**Y7 → decision 3 (AST on every Linux).**
- The release workflow builds `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` with `cross` and publishes them under the existing `linux-x64` and `linux-arm64` asset names.
- It fails if either binary is dynamically linked.

**Y8 → decision 5 (`--clients` selection).**
- Every install records its selected clients in a deployment state file, named by a constant: the `--clients` list when given, otherwise the detected set.
- `doctor` checks only the recorded clients. Any other client prints `[skip] <Client> not selected for this install`, and none fails.
- With no record, as on installs made before this change, `doctor` keeps today's detection rule.
- `uninstall` still removes every Caipira registration it finds, then deletes the record.

**Y9 → workflow and README alignment.**
- **Workflow:** install runtime dependencies from `runtime/` for tests (Node 22). Replace the Node 20/22/24 compatibility job with that Node 22 test run. Keep the macOS and Windows asset jobs; they are contract-level, per decision 1.
- **README:**
  - The install command stays `npm install --global @luismateusvargas/caipira` followed by `caipira install`.
  - State that install downloads the checksum-verified Node 22.23.4 and the runtime dependencies, which needs network access the first time.
  - List the supported targets from the archive table.
  - Make `node bin/caipira-cli.js install` the checkout entry point.

Keep these unchanged: package name, `bin`, the asset names, the UI and model copies, the `better-sqlite3` 12.9.0 pin, and all Task 02 behavior other than the restored registration path and the K1 replacement.

## Acceptance and verification (Linux)

Use fake `HOME` and npm prefixes, and a packed tarball staged with the UI, the model and a real host AST binary.
1. **Any host Node can bootstrap.** Run each of these: Node 22 with npm 10, Node 24 with npm 11, Node 24 with npm 12, and the system Node 26 with npm 12.
   - `npm i -g` blocks no scripts and builds nothing.
   - `caipira install` downloads and verifies Node 22.23.4 into `<home>/.caipira/node22`, installs the runtime dependencies, and exits 0 with Claude Code registered.
   - Registrations name `<home>/.caipira/node22/node-v22.23.4-linux-x64/bin/node`, and the registered hook exits 0.
   - `caipira status` through the npm bin and through `~/.local/bin/caipira` both run on v22.23.4.
2. **Integrity and reuse.**
   - A checksum mismatch (fixture table entry) exits 1 and leaves no `node22`, no client configuration and no change to an existing runtime.
   - A second install with an unchanged runtime and lockfile performs no download and no dependency install.
   - **Upgrade from 22.20.0:** start from a fake deployment holding `node22/node-v22.20.0-linux-x64` and registrations that point at it. Install then registers and launches on `node-v22.23.4-linux-x64`, removes the 22.20.0 directory, and the registered hook exits 0.
3. **Host upgrades don't matter.** After installing, remove or rename the host Node used to start it. Hooks, MCP and `caipira status` keep working.
4. **No PATH fallback.** With `<deployment>/node22` removed, the launcher exits 1 with "run caipira install".
5. **Checkout entry point.**
   - From a checkout with no `node22` and no `node_modules`, `node bin/caipira-cli.js install` on system Node 26 provisions everything and registers the deployment runtime.
   - Moving the checkout afterwards leaves the hooks working.
6. **npm-bin commands act on the deployment.** `caipira mode lite` through the npm bin writes `<deployment>/active`. `status` reports the same mode through the npm bin and through `~/.local/bin`, and `doctor` through the npm bin reports deployment paths.
7. **Dependency changes.** A changed runtime lockfile fixture replaces the deployment's `node_modules`, and a failed dependency install keeps the previous copy.
8. **Optional assets.** Rerunning install from a deployment synced without UI or AST exits 0 with warnings. A package with no host AST asset installs with a warning and registers clients.
9. **`doctor` runtime check.** A missing runtime, or one reporting the wrong version, gives `[FAIL]`; a healthy one reports v22.23.4.
10. **Client selection.**
    - With Claude Code and Codex detected, `install --clients codex` leaves `doctor` exiting 0. It prints `[skip] Claude Code not selected for this install` and checks Codex.
    - A plain `install` afterwards makes `doctor` check both.
11. **Linux targets.**
    - Unit checks cover archive selection for every table entry and refusal for a host with no entry.
    - The version-consistency test passes.
    - A static musl `linux-x64` AST build runs on this host, and `ldd` reports it is not a dynamic executable.
12. **Suite and hygiene.**
    - Run the full suite on a checksum-verified Node 22.23.4, with `NODE_PATH` set to a `node_modules` installed from `runtime/package-lock.json`. Also run the documented command, which still uses the existing 22.20.0 runtime in `~/.caipira`; the real deployment is not reinstalled during implementation.
    - Run `sh -n caipira.sh`, `git diff --check` and a YAML parse of the workflow.
    - `npm pack --dry-run` must list the runtime manifest and lockfile, and the root `package.json` must have no runtime dependencies.

```sh
TMPDIR=/var/tmp NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
```

Completion means X1–X8 are fixed, decisions 2–5 are implemented, and these checks pass, followed by an independent review. Follow the local baseline/completion checkpoints. Do not push, publish, release, bump versions, or add co-author trailers.

## Blockers

- None. Per decision 1, macOS, Windows and the release workflow are verified at contract level.
- **Note:** Node 22 maintenance ends in April 2027. Moving the pin later means changing `NODE_VERSION` and the checksum table. `better-sqlite3` 12.9.0 already has Node 24 prebuilds for a future switch of the bundled runtime.
