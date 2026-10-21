# Block 3: `caipira explore` — React + TypeScript Dark Gray & Dark Red Graph Explorer

Status: ready
Project rules: specs/project.md
Target files: caipira.sh, install.js, explore-server.js, explore-ui/package.json, explore-ui/tsconfig.json, explore-ui/vite.config.ts, explore-ui/index.html, explore-ui/src/main.tsx, explore-ui/src/App.tsx, explore-ui/src/theme/tokens.css, explore-ui/src/api/client.ts, explore-ui/src/api/schemas.ts, explore-ui/src/features/graph/GraphCanvas.tsx, explore-ui/src/features/inspector/SymbolInspectorDrawer.tsx, explore-ui/src/features/knowledge/KnowledgeBoard.tsx, explore-ui/src/features/search/OmniSearchModal.tsx, test/test-explore.js

## Outcome and boundary

Create `caipira explore`: a captivating, local-first web application built with **React 19 + TypeScript + Vite** in a **dark gray and dark red** palette, backed by `explore-server.js`. It bridges human exploration and machine speed by uniting:
- **Madar-style AST Function & Symbol Inspection**: Interactive visualization of files and AST symbols where clicking any function/method/struct reveals **what it receives (`params`: name, type annotation, default)**, **what it returns (`return_type`)**, its docstring summary, source snippet preview, upstream **callers**, downstream **callees**, and **type connections**.
- **Obsidian-style Second-Brain Graph & Fact Curation**: Live graph edges linking knowledge facts (`decision`, `constraint`, `gotcha`, `preference`, `status`) and session digests directly to the files and AST symbols they govern, with visual `NEEDS REVIEW` drift alerts and one-click fact editing, creation, superseding, and reaffirmation.

What changes:
- Add `explore` command to [`caipira.sh`](file:///home/htxzz77/Projects/caipira/caipira.sh) (`caipira explore [--port 4777] [--host 127.0.0.1] [--workspace <path>] [--no-open]`).
- Create [`explore-server.js`](file:///home/htxzz77/Projects/caipira/explore-server.js) serving the compiled React SPA (`explore-ui/dist`) and JSON REST endpoints (`/api/workspaces`, `/api/graph`, `/api/symbols`, `/api/symbol/:id`, `/api/facts`, `POST /api/facts`, `PATCH /api/facts/:id`, `POST /api/reindex`).
- Build the React + TypeScript frontend in `explore-ui/` following `react-dev` and `typescript-dev` rules (feature-scoped directories, runtime payload validation with `zod`/typed parsers in `src/api/schemas.ts`, accessible keyboard controls, and zero `any`).
- Update [`install.js`](file:///home/htxzz77/Projects/caipira/install.js) to build `explore-ui/dist` and copy `explore-server.js` + `explore-ui/dist` into `~/.caipira/`.

Outside scope: Remote multi-user authentication or cloud hosting (binds to `127.0.0.1` by default; `--host` flag provided for explicit local network binding).

## Acceptance criteria

1. **CLI Launch & Local Server (`caipira explore` & `explore-server.js`)**:
   - Running `caipira explore --no-open --port 0` (or default port `4777`) binds to `127.0.0.1` by default, serves the React SPA HTML/JS/CSS bundle at `/`, and exposes JSON endpoints under `/api/*`.
   - Path traversal attempts on source snippet previews (e.g., `../` outside workspace root) are rejected with HTTP `400`/`403`.
2. **Unified Graph API (`GET /api/graph`)**:
   - Returns validated `{ nodes, edges, stats, driftCount }` combining:
     - `file` nodes (grouped by directory/language)
     - `symbol` nodes (`function`, `method`, `struct`, `class`, `interface`, `trait`, `enum`, `component`)
     - `fact` nodes (`decision`, `constraint`, `gotcha`, `preference`, `status`, flagged when drifted)
     - `session` nodes (recent episodic session digests)
     - Directed edges: `defines` (file -> symbol), `calls` (symbol -> symbol), `imports` (file -> file), `uses_type` / `extends` (symbol -> symbol), `evidences` (fact -> file/symbol), `supersedes` (fact -> fact), and `touched` (session -> file/symbol).
3. **Madar-Style Symbol Inspector (`GET /api/symbol/:id` & `SymbolInspectorDrawer.tsx`)**:
   - Selecting any symbol node in the graph or search results opens the side inspector displaying:
     - **Signature header** + language badge + public/private badge + file:line location
     - **Receives (`params`) table**: each parameter's `name`, `type_annotation` (clickable when matching a workspace type symbol), and `default_value`
     - **Returns (`return_type`) badge**: return type (clickable when matching a workspace type symbol) or `void / inferred`
     - **Docstring (`doc_summary`)** and collapsible **Source Preview** (bounded lines `start_line..end_line` from the workspace file)
     - **Callers & Callees**: clickable upstream callers and downstream callees with a **"Focus Blast Radius"** toggle that filters the graph to the N-hop neighborhood of the selected symbol
     - **Attached Second-Brain Facts**: all facts anchored to the symbol or its file, with inline **"+ Attach Fact"** and **"Reaffirm"** actions.
4. **Live Second-Brain Fact Curation (`POST /api/facts`, `PATCH /api/facts/:id` & `KnowledgeBoard.tsx`)**:
   - Users can create a new fact anchored to a symbol/file, supersede/archive an existing fact, or click **"Reaffirm"** on a drifted fact (`NEEDS REVIEW`), which updates `verified_at`, refreshes `fact_evidence.sha256` and `fact_symbol_evidence.signature_hash`, and immediately clears the drift warning in both SQLite and the UI.
5. **Dark Gray & Dark Red Visual Theme & Accessibility**:
   - `explore-ui/src/theme/tokens.css` defines the required dark gray and dark red design tokens:
     - Backgrounds: `--bg-canvas: #0d0e11`, `--bg-panel: #14161b`, `--bg-elevated: #1c1f26`, `--bg-hover: #252932`
     - Borders: `--border-subtle: #262a34`, `--border-crimson: #5c191d`
     - Dark Red / Crimson Accents: `--accent-red-dark: #7f1d1d`, `--accent-red-primary: #b91c1c`, `--accent-red-bright: #dc2626`, `--accent-red-glow: rgba(220, 38, 38, 0.28)`, `--accent-red-soft: #fca5a5`
     - Text: `--text-primary: #f3f4f6`, `--text-secondary: #9ca3af`, `--text-muted: #6b7280`
   - Includes `Ctrl+K` / `Cmd+K` keyboard-accessible `OmniSearchModal` and semantic ARIA roles/labels across all interactive controls.

## Implementation plan

1. **Create [`explore-server.js`](file:///home/htxzz77/Projects/caipira/explore-server.js) and wire [`caipira.sh`](file:///home/htxzz77/Projects/caipira/caipira.sh)**:
   - Implement `createExploreServer({ caipiraDir, defaultWorkspace })` using `node:http` with zero external server framework dependencies:
     - `GET /api/workspaces` -> lists all workspaces from `WorkspaceRegistry` with symbol/file/fact/drift counts.
     - `GET /api/graph` -> builds the combined or filtered node/edge payload (`view=unified|architecture|knowledge|impact`, optional `symbolId`, `pathPrefix`, `kind`, `category`).
     - `GET /api/symbols` -> FTS/filter search via `ast.js`.
     - `GET /api/symbol/:id` -> returns full `inspectSymbol()` payload plus safe bounded source lines read from `path.resolve(ws.root, relPath)` (verified with `relPath` confinement inside `ws.root`).
     - `GET /api/facts`, `POST /api/facts`, `PATCH /api/facts/:id` -> list, record, update/supersede, and reaffirm facts (refreshing file SHA-256 and symbol `signature_hash`).
     - `POST /api/reindex` -> runs incremental `syncWorkspaceAst(ws.root, ws.dbFile)` and returns indexing stats.
     - Static file handler serving `explore-ui/dist` with proper MIME types and SPA fallback.
   - Add `explore)` case to `caipira.sh` launching `explore-server.js` with `~/.caipira/node22/.../bin/node`.
2. **Scaffold and implement `explore-ui/` (React 19 + TypeScript + Vite)**:
   - Configure `explore-ui/package.json`, `tsconfig.json` (`strict: true`, `noUncheckedIndexedAccess: true`), and `vite.config.ts`.
   - Implement `explore-ui/src/api/schemas.ts` and `client.ts` with runtime response validation, `AbortController` support, and typed error translation (`loading | empty | ready | error` union states).
   - Implement `explore-ui/src/theme/tokens.css` with the dark gray (`#0d0e11` / `#14161b` / `#1c1f26`) and dark red (`#7f1d1d` / `#b91c1c` / `#dc2626`) palette, custom scrollbars, and subtle crimson glow effects.
   - Implement `explore-ui/src/features/graph/GraphCanvas.tsx`:
     - Interactive HTML5 Canvas force-directed graph with zoom/pan, node dragging, directional arrows, hover neighborhood dimming, blast-radius isolation mode, and legend/filter pills (`Unified Graph`, `Code Architecture`, `Knowledge Brain`, `Blast Radius`).
     - Distinct visual encoding: dark red octagonal/pill nodes for Knowledge Facts (pulsing crimson ring when `drifted`), crisp slate/crimson nodes for Functions/Structs sized by caller degree, and subtle charcoal group hulls/nodes for Files.
   - Implement `explore-ui/src/features/inspector/SymbolInspectorDrawer.tsx`:
     - Displays Function **Receives (`params`)**, **Returns (`return_type`)**, **Docstring**, **Source Code Preview**, **Callers**, **Callees**, **Type References**, and **Attached Facts** with inline fact creation and drift reaffirmation.
   - Implement `explore-ui/src/features/knowledge/KnowledgeBoard.tsx`:
     - Filterable Second-Brain matrix showing standing facts, trust score bars, evidence links (clickable to jump straight to the symbol/file node in the graph), and one-click drift resolution.
   - Implement `explore-ui/src/features/search/OmniSearchModal.tsx`:
     - `Ctrl+K` / `Cmd+K` modal searching across symbols (by name, parameter type, or return type), files, and facts.
3. **Update [`install.js`](file:///home/htxzz77/Projects/caipira/install.js) and write tests in [`test/test-explore.js`](file:///home/htxzz77/Projects/caipira/test/test-explore.js) + `explore-ui/src/__tests__/`**:
   - Update `install.js` to copy `explore-server.js` and `explore-ui/dist` to `~/.caipira/`.
   - Add `test/test-explore.js` testing all `/api/*` endpoints, symbol input/output inspection, fact creation/reaffirmation, path traversal protection, and static asset serving.
   - Add React component tests in `explore-ui/` verifying the inspector drawer renders function parameters (`Receives`), return types (`Returns`), callers/callees, and attached facts.

## Verification

- `npm --prefix explore-ui run typecheck` — exits `0` with strict TypeScript checking.
- `npm --prefix explore-ui test` — passes all React component and API schema validation tests.
- `npm --prefix explore-ui run build` — produces production bundle in `explore-ui/dist/`.
- `~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/test-explore.js` — passes all HTTP API, graph topology, symbol inspection, fact reaffirmation, and security boundary tests.

## Open decisions and sources

- None.
