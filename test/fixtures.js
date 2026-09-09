// caipira/test/fixtures.js — the fact set the retrieval suites assert against.
//
// test-inject and test-hook used to read whatever happened to be in the live
// workspace database, which made them pass or fail on session history rather
// than on the gate's behaviour. They now seed this fixture into whatever
// CAIPIRA_HOME points at, so a run is reproducible and leaves nothing behind.
//
// Ids matter: the suites assert that a prompt reaches fact #1, #2 or #3, so
// these are recorded in order into an empty database.

const ROOT = require('path').join(__dirname, '..');
const { ensureWorkspace, openWorkspaceDb, machineId } = require(ROOT + '/workspace.js');
const { FactStore } = require(ROOT + '/facts.js');

const FACTS = [
  {
    kind: 'decision',
    title: 'Codex and Antigravity move to caipira; cavemem removed',
    summary: 'Codex repoints from cavemem to caipira (bundled Node 22); Antigravity is a clean install; cavemem package and ~/.cavemem are deleted — its DB held only 4 stale July rows.',
    body: 'All prior memory installations are considered wrong and are to be removed, cavemem included.\n\nCodex: ~/.codex/config.toml points mcp_servers.caipira at the cavemem dist under system Node, and registers five cavemem hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd). All are repointed at ~/.caipira/mcp.js and hooks/universal-hook.js on the bundled Node 22 runtime, and the cavemem package and ~/.cavemem are deleted.\n\nAntigravity: ~/.gemini/config/mcp_config.json is empty and no hooks exist, so this is a clean install with nothing to migrate or un-wire.\n\nNothing is lost by deleting ~/.cavemem/data.db: it holds 4 observations and 8 sessions, all from July, and zero codex rows.\n\nWiring is deliberately sequenced last, after the knowledge layer lands, so these config files are written once rather than twice.'
  },
  {
    kind: 'constraint',
    title: 'Per-workspace databases, master registry, no Postgres schemas',
    summary: 'Each workspace has its own .db under ~/.caipira/database/ with master.db as registry; SQLite has no schemas and caps ATTACH at 10, so steady state is master + current workspace.',
    body: 'Memory is scoped per workspace, not globally. SQLite has no CREATE SCHEMA, so each workspace gets its own .db file under ~/.caipira/database/, and master.db maps workspaces to those files.\n\nATTACH DATABASE provides the linking when a query must span workspaces. This build caps simultaneous attachments at 10, a compile-time limit, so steady state is master + current workspace.\n\nWorkspace identity is the project root, not the cwd, and keys are canonicalised for Windows.'
  },
  {
    kind: 'preference',
    title: 'Injection is prompt-driven at UserPromptSubmit, thresholded not top-N',
    summary: 'Prompt-driven fact injection runs at UserPromptSubmit ranked by trust (relevance x still-true), using a threshold rather than top-N so an unrelated prompt injects nothing.',
    body: 'Retrieval runs at UserPromptSubmit, not SessionStart, because SessionStart has no prompt to search against. SessionStart carries only cheap workspace-scoped standing facts.\n\nRanking is by trust: relevance multiplied by still-true. Use a threshold, never top-N — top-N structurally guarantees noise, because the correct answer to an unrelated prompt is zero facts.'
  }
];

// Idempotent: a database that already holds facts is left exactly as it is.
function seedFacts(workspaceRoot) {
  const workspace = ensureWorkspace(workspaceRoot);
  const db = openWorkspaceDb(workspace.dbFile);
  const store = new FactStore(db, { machine: machineId(), agent: 'test' });
  if (store.count() === 0) {
    for (const fact of FACTS) store.record({ ...fact, scope: 'workspace' });
  }
  return { workspace, db, store };
}

module.exports = { seedFacts, FACTS };
