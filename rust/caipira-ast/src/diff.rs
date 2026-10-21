//! Before/after comparison of one file's symbols.
//!
//! Extends Sota's `compare_snapshots`: every symbol is compared, not only
//! public ones (each entry carries `is_public` for callers that filter), and
//! a modified symbol reports both signatures. Symbols match by
//! `(qualified_name, kind)`; repeats such as overloads pair up in order.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::parser::SymbolSignature;

/// A symbol whose signature hash changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolChange {
    pub before: SymbolSignature,
    pub after: SymbolSignature,
}

/// What changed in a file's symbols between two parses.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AstDiffReport {
    /// Symbols present only after.
    pub added: Vec<SymbolSignature>,
    /// Symbols present only before.
    pub removed: Vec<SymbolSignature>,
    /// Symbols in both whose `signature_hash` differs.
    pub modified: Vec<SymbolChange>,
}

impl AstDiffReport {
    /// True when nothing was added, removed, or modified.
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.modified.is_empty()
    }
}

/// Compares two symbol lists for the same file.
///
/// # Arguments
/// `before`: the symbols previously stored. `after`: the symbols just parsed.
pub fn compare_snapshots(before: &[SymbolSignature], after: &[SymbolSignature]) -> AstDiffReport {
    let mut previous: HashMap<(&str, &str), VecDeque<&SymbolSignature>> = HashMap::new();
    for symbol in before {
        previous.entry(key(symbol)).or_default().push_back(symbol);
    }
    let mut report = AstDiffReport::default();
    for symbol in after {
        match previous.get_mut(&key(symbol)).and_then(VecDeque::pop_front) {
            Some(old) if old.signature_hash != symbol.signature_hash => {
                report.modified.push(SymbolChange {
                    before: old.clone(),
                    after: symbol.clone(),
                });
            }
            Some(_) => {}
            None => report.added.push(symbol.clone()),
        }
    }
    // Leftovers, in their original order.
    for symbol in before {
        if let Some(queue) = previous.get_mut(&key(symbol))
            && queue.front().is_some_and(|s| std::ptr::eq(*s, symbol))
        {
            queue.pop_front();
            report.removed.push(symbol.clone());
        }
    }
    report
}

fn key(symbol: &SymbolSignature) -> (&str, &str) {
    (symbol.qualified_name.as_str(), symbol.kind.as_str())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;
    use crate::parser::ParamSignature;

    fn sym(name: &str, kind: &str, return_type: &str) -> SymbolSignature {
        SymbolSignature::default()
            .name(name)
            .qualified_name(name)
            .kind(kind)
            .is_public(true)
            .return_type(return_type)
            .hashed()
    }

    #[test]
    fn identical_lists_are_empty() {
        let fixture = vec![sym("a", "function", "i32")];
        let actual = compare_snapshots(&fixture, &fixture);
        assert!(actual.is_empty());
    }

    #[test]
    fn reports_added_removed_and_modified() {
        let before = vec![
            sym("keep", "function", "i32"),
            sym("gone", "function", "i32"),
            sym("changed", "function", "i32"),
        ];
        let changed = sym("changed", "function", "i32")
            .params(vec![ParamSignature::new("x")])
            .hashed();
        let after = vec![
            sym("keep", "function", "i32"),
            changed.clone(),
            sym("new", "function", "i32"),
        ];
        let actual = compare_snapshots(&before, &after);
        let expected = AstDiffReport {
            added: vec![sym("new", "function", "i32")],
            removed: vec![sym("gone", "function", "i32")],
            modified: vec![SymbolChange {
                before: sym("changed", "function", "i32"),
                after: changed,
            }],
        };
        assert_eq!(actual, expected);
    }

    #[test]
    fn line_moves_are_not_modifications_and_kind_changes_are() {
        let before = vec![sym("f", "function", "i32"), sym("x", "const", "")];
        let after = vec![
            sym("f", "function", "i32").start_line(40usize),
            sym("x", "function", ""),
        ];
        let actual = compare_snapshots(&before, &after);
        assert_eq!(actual.modified, vec![]);
        assert_eq!(actual.added, vec![sym("x", "function", "")]);
        assert_eq!(actual.removed, vec![sym("x", "const", "")]);
    }

    #[test]
    fn repeated_names_pair_in_order() {
        let before = vec![sym("f", "function", "i32"), sym("f", "function", "bool")];
        let after = vec![sym("f", "function", "i32")];
        let actual = compare_snapshots(&before, &after);
        assert_eq!(actual.removed, vec![sym("f", "function", "bool")]);
        assert!(actual.added.is_empty() && actual.modified.is_empty());
    }
}
