//! `caipira-ast`: index a workspace, update one file, or parse one file.
//!
//! Results are one JSON document on stdout. Failures are one JSON line on
//! stderr, `{"error": <code>, "message": <text>}`, with a non-zero exit code
//! per [`AstError::exit_code`], which `ast.js` maps onto typed errors.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use caipira_ast::{
    AstError, Resolver, index_workspace, open_database, parse_source, update_single_file,
    workspace_relative,
};
use clap::{Parser, Subcommand};
use serde::Serialize;

#[derive(Parser)]
#[command(
    name = "caipira-ast",
    version,
    about = "Incremental tree-sitter symbol indexer for Caipira"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Incrementally index every supported file in a workspace.
    Index {
        #[arg(long)]
        workspace: PathBuf,
        #[arg(long)]
        db: PathBuf,
    },
    /// Re-index one file and report its symbol diff.
    UpdateFile {
        #[arg(long)]
        workspace: PathBuf,
        #[arg(long)]
        db: PathBuf,
        #[arg(long)]
        file: PathBuf,
    },
    /// Parse one file and print its snapshot without touching a database.
    ParseFile {
        #[arg(long)]
        workspace: PathBuf,
        #[arg(long)]
        file: PathBuf,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli.command) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            let report = serde_json::json!({ "error": error.code(), "message": error.to_string() });
            eprintln!("{report}");
            ExitCode::from(error.exit_code())
        }
    }
}

fn run(command: Command) -> Result<String, AstError> {
    match command {
        Command::Index { workspace, db } => {
            let root = workspace_root(&workspace)?;
            let mut conn = open_database(&db)?;
            to_json(&index_workspace(&mut conn, &root)?)
        }
        Command::UpdateFile {
            workspace,
            db,
            file,
        } => {
            let rel_path = workspace_relative(&workspace, &file)?;
            let root = workspace_root(&workspace)?;
            let mut conn = open_database(&db)?;
            to_json(&update_single_file(&mut conn, &root, &rel_path)?)
        }
        Command::ParseFile { workspace, file } => {
            let rel_path = workspace_relative(&workspace, &file)?;
            let root = workspace_root(&workspace)?;
            let absolute = root.join(&rel_path);
            let bytes = std::fs::read(&absolute).map_err(|e| AstError::io(&absolute, e))?;
            to_json(&parse_source(&rel_path, &bytes, &Resolver::new(&root))?)
        }
    }
}

/// The canonical workspace root, so walked paths strip to clean relatives.
fn workspace_root(workspace: &Path) -> Result<PathBuf, AstError> {
    if !workspace.is_dir() {
        return Err(AstError::InvalidArgument(format!(
            "workspace is not a directory: {}",
            workspace.display()
        )));
    }
    workspace
        .canonicalize()
        .map_err(|e| AstError::io(workspace, e))
}

fn to_json(value: &impl Serialize) -> Result<String, AstError> {
    serde_json::to_string(value)
        .map_err(|e| AstError::InvalidArgument(format!("could not serialize the result: {e}")))
}
