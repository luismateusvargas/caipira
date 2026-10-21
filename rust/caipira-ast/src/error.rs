use std::path::PathBuf;

/// Failures the indexer reports to its caller.
///
/// Each variant has a stable [`AstError::code`] and process exit code, so
/// the Node bridge can map a failed run onto a typed error without parsing
/// the human-readable message.
#[derive(Debug, thiserror::Error)]
pub enum AstError {
    /// A command-line argument or path was unusable.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// The file extension has no parser.
    #[error("unsupported file type: {0}")]
    Unsupported(String),
    /// Reading a workspace file or directory failed.
    #[error("I/O error on {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// A SQLite statement failed.
    #[error("database error while {context}: {source}")]
    Database {
        context: String,
        #[source]
        source: rusqlite::Error,
    },
    /// tree-sitter could not produce a tree for a file.
    #[error("parse error in {path}: {message}")]
    Parse { path: String, message: String },
}

impl AstError {
    /// Wraps a SQLite failure with the operation that was running.
    ///
    /// # Arguments
    /// `context`: what the indexer was doing, e.g. "writing ast_symbols".
    /// `source`: the underlying rusqlite error.
    pub fn database(context: &str, source: rusqlite::Error) -> Self {
        Self::Database {
            context: context.to_string(),
            source,
        }
    }

    /// Wraps an I/O failure with the path it happened on.
    ///
    /// # Arguments
    /// `path`: the file or directory being accessed.
    /// `source`: the underlying I/O error.
    pub fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }

    /// Stable machine-readable error code written to stderr.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidArgument(_) => "invalid_argument",
            Self::Unsupported(_) => "unsupported",
            Self::Io { .. } => "io",
            Self::Database { .. } => "database",
            Self::Parse { .. } => "parse",
        }
    }

    /// Process exit code for this failure (clap itself uses 2 for bad usage).
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::InvalidArgument(_) => 2,
            Self::Io { .. } => 3,
            Self::Database { .. } => 4,
            Self::Parse { .. } => 5,
            Self::Unsupported(_) => 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn codes_and_exit_codes_are_stable() {
        let fixture = [
            AstError::InvalidArgument("x".into()),
            AstError::Unsupported("a.txt".into()),
            AstError::io("a", std::io::Error::other("boom")),
            AstError::database("reading", rusqlite::Error::InvalidQuery),
            AstError::Parse {
                path: "a.rs".into(),
                message: "none".into(),
            },
        ];
        let actual: Vec<_> = fixture.iter().map(|e| (e.code(), e.exit_code())).collect();
        let expected = vec![
            ("invalid_argument", 2),
            ("unsupported", 6),
            ("io", 3),
            ("database", 4),
            ("parse", 5),
        ];
        assert_eq!(actual, expected);
    }
}
