# Zero-prerequisite npm distribution and cross-platform prebuilt asset packaging

Status: implemented — pending independent review
Project rules: specs/project.md
Target files: package.json, package-lock.json, bin/caipira-cli.js, install.js, ast.js, caipira.sh, caipira.cmd, .github/workflows/release.yml, README.md, test/test-install.js

## Outcome and boundary

Package Caipira so that any user on Linux (`x64`/`arm64`), macOS (`arm64`/`x64`), or Windows (`x64`) can run `npm i -g @luismateusvargas/caipira` followed by `caipira install` and have the entire system working out of the box with zero prerequisites (no Rust/`cargo` toolchain, no Node ABI mismatch, no `npm ci` inside `explore-ui`, and no manual ONNX model downloads). Configure `package.json` with the scoped package name `@luismateusvargas/caipira`, a global CLI entrypoint (`bin/caipira-cli.js`), and a strict distribution `files` whitelist including pre-built `explore-ui/dist/`. Provide automated platform binary resolution in `ast.js` and `install.js` that uses pre-compiled `caipira-ast` binaries for all 5 host targets, falling back to local `cargo build` only on development checkouts. Add a multi-platform GitHub Actions release workflow (`.github/workflows/release.yml`) for automated release artifact building and npm publishing.

Outside scope: Topic 3 deliverables (15-second visual screen recording, context/cost benchmark suite, and interactive demo sandbox), which remain deferred until Tasks 01–03 are verified.

## Acceptance criteria

1. **Global npm executable packaging**:
   - `package.json` is updated with `"name": "@luismateusvargas/caipira"`, `"bin": { "caipira": "bin/caipira-cli.js" }`, and a `"files"` whitelist ensuring the published package includes core runtime `.js` files, `hooks/`, `bin/`, `explore-server.js`, pre-built `explore-ui/dist/`, and local ONNX embedding models.
   - `bin/caipira-cli.js` functions across Linux, macOS, and Windows: under Node 22 it delegates to a compatible bundled runtime under `~/.caipira/node22/` when present; Node 20 and 24 use the matching host runtime so the native SQLite prebuild ABI matches.
2. **Zero-prerequisite pre-built AST binary resolution**:
   - `ast.js` and `install.js` resolve `caipira-ast` across 5 platform/architecture targets:
     - Linux x64 (`linux-x64`)
     - Linux ARM64 (`linux-arm64`)
     - macOS Apple Silicon (`darwin-arm64`)
     - macOS Intel (`darwin-x64`)
     - Windows x64 (`win32-x64`)
   - If a pre-compiled `caipira-ast` matching the host platform exists in `bin/` or is resolved from platform assets, `buildAstEngine()` installs it to `<CAIPIRA_HOME>/bin/caipira-ast` and skips `cargo build` without warning.
   - Local `cargo build --release` is executed only when running from a git checkout where pre-compiled binaries are absent.
3. **Zero-prerequisite pre-built Explore UI deployment**:
   - When `explore-ui/dist/index.html` is present (included in the npm distribution), `install.js` copies the bundle directly into `<CAIPIRA_HOME>/explore-ui/dist` and skips `npm ci` and `vite build`.
4. **Node native ABI compatibility and fallback**:
   - For users running Node 20, 22, or 24, native SQLite (`better-sqlite3`) loads from precompiled Node-ABI-specific prebuilds. If running under an incompatible Node major where native compilation is unavailable, npm can complete because the addon is optional, and `install.js` logs the supported Node versions and recommended action.
   - Pin `better-sqlite3@12.9.0`, whose prebuild matrix includes Node 20, 22, and 24. Keep it optional so an unsupported host Node can still reach Caipira's actionable compatibility message.
5. **Multi-platform CI release workflow**:
   - `.github/workflows/release.yml` compiles `caipira-ast` across `ubuntu-latest` (x64 and arm64 cross), `macos-15` (arm64), `macos-15-intel` (x64), and `windows-latest` (x64).
   - The workflow builds `explore-ui/dist`, verifies tests across all platforms, stages platform binaries into the release archive, and publishes `@luismateusvargas/caipira` to npm.

## Implementation plan

1. **Configure `package.json`**:
   - Rename to `"@luismateusvargas/caipira"`.
   - Add `"bin": { "caipira": "bin/caipira-cli.js" }`.
   - Add a strict `"files"` whitelist for the root runtime modules, `bin/`, `hooks/`, `explore-ui/dist/`, `models/`, the platform launchers, `LICENSE`, and `README.md`.
2. **Create `bin/caipira-cli.js`**:
   - Cross-platform entrypoint with `#!/usr/bin/env node`.
   - When invoked under Node 22, uses a compatible bundled runtime under `~/.caipira/node22/` when present; Node 20 and 24 execute `install.js` with the matching host runtime.
3. **Upgrade platform binary resolution in `ast.js` and `install.js`**:
   - Define platform target key: `${process.platform}-${process.arch}`.
   - Search candidate binary paths: `bin/caipira-ast-${target}`, `bin/caipira-ast`, `<CAIPIRA_HOME>/bin/caipira-ast`.
   - Update `buildAstEngine()` in `install.js`: check if a valid platform binary exists; if found, copy atomically to `<CAIPIRA_HOME>/bin/caipira-ast` and skip `cargo`.
   - Update `buildExploreUi()` in `install.js`: check if `explore-ui/dist/index.html` exists; if found, deploy directly and skip `npm ci` / `vite build`.
4. **Create GitHub Actions release workflow (`.github/workflows/release.yml`)**:
   - Matrix build: Linux x64, Linux arm64 (`cross`), macOS arm64, macOS x64, Windows x64. Use current hosted runner labels (`macos-15` for arm64 and `macos-15-intel` for x64).
   - Run `cargo test` and `cargo build --release`.
   - Run `npm --prefix explore-ui run build`.
   - Package release tarballs/zips and publish npm package on version tags (`v*`).
5. **Update documentation in `README.md`**:
   - Update installation instructions to lead with `npm i -g @luismateusvargas/caipira` followed by `caipira install`.
   - Document zero-prerequisite installation.

## Verification

- `npm pack --dry-run` — verifies that `package.json` includes all necessary runtime files, pre-built `explore-ui/dist/`, and CLI bin while omitting source code and development node_modules.
- `node test/test-install.js` — verifies that `install.js` correctly deploys pre-compiled binaries and pre-built UI bundles without requiring `cargo` or `vite`.
- `node test/run-all.js` — full test suite passes with 0 failures.

## Implementation evidence

- Baseline checkpoint: `255159fd002072c32ce4ef5283ad03d7fb9e97d2`.
- Changed paths: `package.json`, `package-lock.json`, `bin/caipira-cli.js`, `install.js`, `ast.js`, `caipira.sh`, `caipira.cmd`, `.github/workflows/release.yml`, `README.md`, `test/test-install.js`, and this task spec.
- The scoped package exposes the CLI with a strict files whitelist. The installer deploys matching prebuilt AST and UI assets, copies missing model/runtime dependency files, refreshes a stale or unloadable SQLite package with rollback, and rejects unsupported Node majors before writes. Development checkouts keep their Cargo build path.
- The release workflow builds and tests the five AST targets, exercises Node 20/22/24, builds the UI, downloads the pinned model files and checksum, validates both npm pack JSON formats, and publishes only on version tags.
- `test/test-install.js`: **192 passed, 0 failed**. Full `test/run-all.js`: **1,021 passed, 0 failed**. JavaScript syntax checks, `sh -n caipira.sh`, workflow YAML parsing, and `git diff --check` passed.
- A staged `npm pack --dry-run --json` with placeholder AST/model assets emitted 31 files, including every required platform binary name, CLI, UI, and model path; the verification rejected development files. Production assets are generated by the release workflow and were not present locally.
- Limits: the GitHub Actions platform matrices, native Windows/macOS/Linux ARM64 runs, and npm publish were not run from this checkout. Independent review remains pending; no release or approval tag was created.

## Open decisions and sources

- Implementation constraint: pin `better-sqlite3@12.9.0`. The locked v11.10.0 does not provide a Node 24 prebuild, while v12.10.0 removed Node 20 from its prebuild matrix. The 12.9.0 pin retains the requested Node 20/22/24 support.
- Primary sources: npm `package.json` `bin` and `files` specification; the upstream `better-sqlite3` v12.9.0 and v12.10.0 release notes; GitHub-hosted runner labels; the pinned Xenova model file and checksum.
