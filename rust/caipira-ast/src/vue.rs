//! Vue single-file components: the `<script>` and `<script setup>` blocks.
//!
//! Rather than parse each block on its own and shift node positions back,
//! everything outside the script blocks is blanked to spaces with newlines
//! kept, so the masked buffer has the same bytes, lines, and columns as the
//! `.vue` file and tree-sitter reports original line numbers directly.

use std::ops::Range;

use crate::parser::Language;

/// A `.vue` file reduced to its script blocks at their original offsets.
pub(crate) struct ScriptView {
    /// The grammar the script blocks are written in.
    pub language: Language,
    /// The file with every byte outside a script block replaced by a space
    /// (newlines kept), so offsets and line numbers are unchanged.
    pub masked: Vec<u8>,
}

struct ScriptBlock {
    content: Range<usize>,
    language: Language,
    end: usize,
}

/// Builds the masked view of a `.vue` file's script blocks.
pub(crate) fn script_view(source: &[u8]) -> ScriptView {
    let mut masked: Vec<u8> = source
        .iter()
        .map(|&b| if b == b'\n' { b'\n' } else { b' ' })
        .collect();
    let mut languages = Vec::new();
    let mut from = 0;
    while let Some(block) = next_script(source, from) {
        masked[block.content.clone()].copy_from_slice(&source[block.content.clone()]);
        languages.push(block.language);
        from = block.end;
    }
    ScriptView {
        language: combined_language(&languages),
        masked,
    }
}

/// One grammar for every block: TSX covers TS + JSX, TS covers plain JS.
fn combined_language(languages: &[Language]) -> Language {
    let has = |l: Language| languages.contains(&l);
    if has(Language::Tsx) || (has(Language::TypeScript) && has(Language::Jsx)) {
        Language::Tsx
    } else if has(Language::TypeScript) {
        Language::TypeScript
    } else if has(Language::Jsx) {
        Language::Jsx
    } else {
        Language::JavaScript
    }
}

fn next_script(source: &[u8], mut from: usize) -> Option<ScriptBlock> {
    loop {
        let start = find_ci(source, b"<script", from)?;
        // A commented-out block (`<!-- <script> -->`) is not a script.
        if let Some(comment) = find_ci(source, b"<!--", from).filter(|c| *c < start) {
            from = find_ci(source, b"-->", comment + 4).map_or(source.len(), |end| end + 3);
            continue;
        }
        let after_name = start + b"<script".len();
        let boundary = source.get(after_name).copied();
        if !boundary.is_some_and(|b| b.is_ascii_whitespace() || b == b'>' || b == b'/') {
            from = after_name;
            continue;
        }
        let tag_end = find_tag_end(source, after_name)?;
        let attributes = &source[after_name..tag_end];
        if attributes.trim_ascii_end().ends_with(b"/") {
            from = tag_end + 1;
            continue;
        }
        let content_start = tag_end + 1;
        let close = find_ci(source, b"</script", content_start).unwrap_or(source.len());
        let end = source[close..]
            .iter()
            .position(|&b| b == b'>')
            .map_or(source.len(), |p| close + p + 1);
        return Some(ScriptBlock {
            content: content_start..close,
            language: lang_attribute(attributes),
            end,
        });
    }
}

/// The `>` closing an opening tag, skipping `>` inside quoted attributes.
fn find_tag_end(source: &[u8], from: usize) -> Option<usize> {
    let mut quote = None;
    for (offset, &b) in source[from..].iter().enumerate() {
        match (quote, b) {
            (None, b'"' | b'\'') => quote = Some(b),
            (Some(q), _) if b == q => quote = None,
            (None, b'>') => return Some(from + offset),
            _ => {}
        }
    }
    None
}

fn lang_attribute(attributes: &[u8]) -> Language {
    let text = String::from_utf8_lossy(attributes).to_ascii_lowercase();
    let value = text.split_once("lang").and_then(|(_, rest)| {
        let rest = rest.trim_start().strip_prefix('=')?.trim_start();
        let value: String = rest
            .trim_start_matches(['"', '\''])
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        Some(value)
    });
    match value.as_deref() {
        Some("ts") | Some("typescript") => Language::TypeScript,
        Some("tsx") => Language::Tsx,
        Some("jsx") => Language::Jsx,
        _ => Language::JavaScript,
    }
}

fn find_ci(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= haystack.len() || needle.len() > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
        .map(|p| from + p)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;
    use crate::parser::test_support::{parse, symbol};
    use crate::parser::{EdgeKind, ParamSignature};

    const COMPONENT: &str = r#"<template>
  <div @click="save(user)">{{ label }}</div>
</template>

<script lang="ts">
export interface Props { label: string }
export default { name: 'Card' }
</script>

<script setup lang="ts">
import { formatLabel } from './format';

/** Saves the user. */
function save(user: User, retries = 2): Promise<void> {
  return formatLabel(user.name);
}
const label = computed(() => formatLabel('x'));
</script>

<style scoped>
.card { color: red; }
</style>
"#;

    #[test]
    fn masked_view_keeps_offsets_and_detects_language() {
        let actual = script_view(COMPONENT.as_bytes());
        assert_eq!(actual.language, Language::TypeScript);
        assert_eq!(actual.masked.len(), COMPONENT.len());
        let masked = String::from_utf8(actual.masked).unwrap();
        assert_eq!(masked.lines().count(), COMPONENT.lines().count());
        assert!(!masked.contains("<template>") && !masked.contains(".card"));
        let line = |text: &str, n: usize| text.lines().nth(n - 1).unwrap().to_string();
        assert_eq!(line(&masked, 14), line(COMPONENT, 14));
    }

    #[test]
    fn script_setup_symbols_report_vue_file_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("format.ts"), "").unwrap();
        let actual = parse(dir.path(), "Card.vue", COMPONENT);

        let save = symbol(&actual, "save");
        assert_eq!((save.start_line, save.end_line), (14, 16));
        assert_eq!(
            save.params,
            vec![
                ParamSignature::new("user").type_annotation("User"),
                ParamSignature::new("retries").default_value("2"),
            ]
        );
        assert_eq!(save.return_type.as_deref(), Some("Promise<void>"));
        assert_eq!(save.doc_summary.as_deref(), Some("Saves the user."));
        let props = symbol(&actual, "Props");
        assert_eq!((props.start_line, props.is_public), (6, true));
        assert_eq!(symbol(&actual, "label").start_line, 17);
        let calls: Vec<_> = actual
            .edges
            .iter()
            .filter(|e| {
                e.edge_kind == EdgeKind::Calls && e.source_symbol.as_deref() == Some("save")
            })
            .map(|e| (e.target_path.clone(), e.target_symbol.clone()))
            .collect();
        assert_eq!(
            calls,
            vec![(Some("format.ts".to_string()), "formatLabel".to_string())]
        );
        assert_eq!(actual.language, Language::Vue);
    }

    #[test]
    fn lang_attribute_variants() {
        let actual: Vec<_> = [
            &b" setup lang=\"tsx\""[..],
            b" lang='jsx'",
            b" lang=ts",
            b"",
            b" setup",
        ]
        .iter()
        .map(|a| lang_attribute(a))
        .collect();
        let expected = vec![
            Language::Tsx,
            Language::Jsx,
            Language::TypeScript,
            Language::JavaScript,
            Language::JavaScript,
        ];
        assert_eq!(actual, expected);
    }
}
