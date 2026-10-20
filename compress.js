// caipira/compress.js — boundary-protected prose compression and search forms
// Originated in @cavemem/compress.
// Stays out of code blocks, URLs, paths, identifiers, versions, etc.

/** @typedef {{kind: string, text: string, preserved: boolean}} Segment */
/** @typedef {{intensity?: string}} CompressionOptions */

// ── LEXICON ──

const LEXICON = {
  fillers: {
    lite: ["basically","really","just","actually","simply","literally","quite","rather","very","kind of","sort of","pretty much"],
    full: ["basically","really","just","actually","simply","literally","quite","rather","very","kind of","sort of","pretty much","in order to","it should be noted that","as a matter of fact","please note that","i think that","i believe that","it seems that","it appears that"],
    ultra: ["basically","really","just","actually","simply","literally","quite","rather","very","kind of","sort of","pretty much","in order to","it should be noted that","as a matter of fact","please note that","i think that","i believe that","it seems that","it appears that","perhaps","possibly","probably","generally","typically","usually"]
  },
  articles: {
    lite: [],
    full: ["the","a","an"],
    ultra: ["the","a","an"]
  },
  hedges: {
    lite: [],
    full: ["i would recommend","we should probably","it might be","might want to","could potentially","may possibly"],
    ultra: ["i would recommend","i recommend","we recommend","i would","we should","we should probably","it might be","might want to","could potentially","may possibly","i think","i believe","probably","maybe","perhaps"]
  },
  pleasantries: {
    lite: ["please","thanks","thank you","sorry","sure","of course","no problem"],
    full: ["please","thanks","thank you","sorry","sure","of course","no problem","happy to help"],
    ultra: ["please","thanks","thank you","sorry","sure","of course","no problem","happy to help"]
  },
  abbreviations: {
    lite: { configuration:"config", implementation:"impl", documentation:"docs", repository:"repo", repositories:"repos" },
    full: { configuration:"config", implementation:"impl", documentation:"docs", repository:"repo", repositories:"repos", database:"db", databases:"dbs", application:"app", applications:"apps", environment:"env", environments:"envs", dependency:"dep", dependencies:"deps", directory:"dir", directories:"dirs", parameter:"param", parameters:"params", argument:"arg", arguments:"args", function:"fn", functions:"fns", variable:"var", variables:"vars", reference:"ref", references:"refs", authentication:"auth", authorization:"authz", middleware:"mw", request:"req", response:"resp", message:"msg", messages:"msgs", transaction:"tx", transactions:"txs", asynchronous:"async", synchronous:"sync", because:"b/c", with:"w/", without:"w/o", should:"shld", would:"wld", could:"cld", number:"num", between:"btwn", through:"thru", and:"&", before:"b4", maximum:"max", minimum:"min" },
    ultra: { configuration:"cfg", implementation:"impl", documentation:"docs", repository:"repo", repositories:"repos", database:"db", databases:"dbs", application:"app", applications:"apps", environment:"env", environments:"envs", dependency:"dep", dependencies:"deps", directory:"dir", directories:"dirs", parameter:"param", parameters:"params", argument:"arg", arguments:"args", function:"fn", functions:"fns", variable:"var", variables:"vars", reference:"ref", references:"refs", authentication:"auth", authorization:"authz", middleware:"mw", request:"req", response:"resp", message:"msg", messages:"msgs", transaction:"tx", transactions:"txs", asynchronous:"async", synchronous:"sync", because:"b/c", with:"w/", without:"w/o", should:"shld", would:"wld", could:"cld", number:"num", between:"btwn", through:"thru", and:"&", before:"b4", maximum:"max", minimum:"min" }
  },
  expansions: {
    impl:"implementation", config:"configuration", cfg:"configuration", docs:"documentation", repo:"repository", repos:"repositories", db:"database", dbs:"databases", app:"application", apps:"applications", env:"environment", envs:"environments", dep:"dependency", deps:"dependencies", dir:"directory", dirs:"directories", param:"parameter", params:"parameters", arg:"argument", args:"arguments", fn:"function", fns:"functions", var:"variable", vars:"variables", ref:"reference", refs:"references", auth:"authentication", authz:"authorization", mw:"middleware", req:"request", resp:"response", msg:"message", msgs:"messages", tx:"transaction", txs:"transactions", "b/c":"because", "w/":"with", "w/o":"without", shld:"should", wld:"would", cld:"could", num:"number", btwn:"between", thru:"through", b4:"before", max:"maximum", min:"minimum"
  }
};

function fillersFor(i) { return LEXICON.fillers[i]; }
function articlesFor(i) { return LEXICON.articles[i]; }
function hedgesFor(i) { return LEXICON.hedges[i]; }
function pleasantriesFor(i) { return LEXICON.pleasantries[i]; }
function abbreviationsFor(i) { return LEXICON.abbreviations[i]; }
function expansions() { return LEXICON.expansions; }

// ── TOKENIZE ──

const RULES = [
  { kind: "fence", priority: 100, re: /```[\s\S]*?```|~~~[\s\S]*?~~~/g },
  { kind: "inline-code", priority: 90, re: /`[^`\n]+`/g },
  { kind: "url", priority: 80, re: /\bhttps?:\/\/[^\s)\]]+/g },
  { kind: "heading", priority: 70, re: /^#{1,6}\s[^\n]*$/gm },
  { kind: "path", priority: 60, re: /(?:(?:\.{1,2}|~)\/[A-Za-z0-9._/-]+|[A-Z]:\\[A-Za-z0-9._\\-]+|(?<=^|[\s"'`])\/[A-Za-z0-9._/-]+|(?<![A-Za-z0-9._/-])(?:[A-Za-z0-9._-]{2,}\/[A-Za-z0-9._/-]+|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]{2,}[A-Za-z0-9._/-]*|(?:[A-Za-z0-9._-]+\/){2,}[A-Za-z0-9._/-]+))/g },
  { kind: "date", priority: 50, re: /\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?\b/g },
  { kind: "version", priority: 40, re: /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/g },
  { kind: "number", priority: 30, re: /\b\d+(?:\.\d+)?\b/g },
  { kind: "identifier", priority: 20, re: /\b[A-Za-z_][A-Za-z0-9_]*[-_][A-Za-z0-9_\-]+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g }
];

/** @param {string} input @returns {Segment[]} */
function tokenize(input) {
  const spans = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m = re.exec(input);
    while (m !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; }
      else { spans.push({ start: m.index, end: m.index + m[0].length, kind: rule.kind, priority: rule.priority }); }
      m = re.exec(input);
    }
  }
  spans.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.end - a.end;
  });
  const resolved = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    resolved.push(s);
    cursor = s.end;
  }
  resolved.sort((a, b) => a.start - b.start);
  const out = [];
  let pos = 0;
  for (const s of resolved) {
    if (s.start > pos) out.push({ kind: "prose", text: input.slice(pos, s.start), preserved: false });
    out.push({ kind: s.kind, text: input.slice(s.start, s.end), preserved: true });
    pos = s.end;
  }
  if (pos < input.length) out.push({ kind: "prose", text: input.slice(pos), preserved: false });
  return out;
}

// ── EXPAND ──

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function matchCase(source, target) {
  if (source === source.toUpperCase()) return target.toUpperCase();
  if (source[0] === source[0]?.toUpperCase()) return target[0]?.toUpperCase() + target.slice(1);
  return target;
}
/** @param {string} input @returns {string} */
function expand(input) {
  if (typeof input !== 'string' || !input) return '';
  const segments = tokenize(input);
  const map = expansions();
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return input;
  const pattern = new RegExp(`(?<=^|[^\\p{L}\\p{N}])(?:${keys.map(escapeRe).join("|")})(?=$|[^\\p{L}\\p{N}])`, "giu");
  return segments.map((seg) => {
    if (seg.preserved) return seg.text;
    return seg.text.replace(pattern, (match) => {
      const key = match.toLowerCase();
      const target = map[key];
      return target ? matchCase(match, target) : match;
    });
  }).join("");
}

// ── COMPRESS ──

function removePhrases(text, phrases) {
  if (phrases.length === 0) return text;
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`\\b(?:${sorted.map(escapeRe).join("|")})\\b`, "gi");
  return text.replace(pattern, "");
}
function abbreviate(text, map) {
  let result = text;
  for (const [from, to] of Object.entries(map)) {
    const re = new RegExp(`\\b${escapeRe(from)}\\b`, "gi");
    result = result.replace(re, (match) => matchCase(match, to));
  }
  return result;
}
function collapseWhitespace(text) {
  return text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/ +([.,;:!?])/g, "$1").replace(/\n{3,}/g, "\n\n").replace(/^ +| +$/gm, "");
}
/** @param {string} intensity @returns {string} */
function normalizeIntensity(intensity) {
  return Object.hasOwn(LEXICON.fillers, intensity) ? intensity : 'full';
}
/** @param {string} text @param {string} intensity @returns {string} */
function compressProse(text, intensity) {
  if (typeof text !== 'string' || !text) return '';
  const validIntensity = normalizeIntensity(intensity);
  const leadingMatch = text.match(/^\s+/);
  const trailingMatch = text.match(/\s+$/);
  const leading = leadingMatch ? leadingMatch[0] : "";
  const trailing = trailingMatch ? trailingMatch[0] : "";
  const body = text.slice(leading.length, text.length - trailing.length);
  if (body.length === 0) return text;
  let out = body;
  out = removePhrases(out, pleasantriesFor(validIntensity));
  out = removePhrases(out, hedgesFor(validIntensity));
  out = removePhrases(out, fillersFor(validIntensity));
  out = removePhrases(out, articlesFor(validIntensity));
  out = abbreviate(out, abbreviationsFor(validIntensity));
  out = collapseWhitespace(out);
  const leftPad = leading.includes("\n") ? "\n" : leading ? " " : "";
  const rightPad = trailing.includes("\n") ? "\n" : trailing ? " " : "";
  return `${leftPad}${out}${rightPad}`;
}
/** @param {string} input @param {CompressionOptions} [opts] @returns {string} */
function compress(input, opts = {}) {
  if (typeof input !== 'string' || !input) return '';
  const intensity = normalizeIntensity(opts?.intensity);
  const segments = tokenize(input);
  const out = [];
  for (const seg of segments) {
    if (seg.preserved) { out.push(seg.text); continue; }
    out.push(compressProse(seg.text, intensity));
  }
  return out.join("").replace(/[ \t]+(?!\.{1,2}\/)([.,;:!?])/g, "$1");
}

// ── COUNT ──

/** @param {string} text @returns {number} */
function countTokens(text) {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  return Math.max(words, Math.round(chars / 4));
}

// Search stored prose in either its typed, compressed, or expanded form.
const SEARCH_INTENSITIES = ['full', 'ultra'];

/** @param {string} value @returns {boolean} */
function hasSearchableChars(value) {
  return /[\p{L}\p{N}]/u.test(value);
}

/** @param {string} term @returns {string[]} */
function termForms(term) {
  if (typeof term !== 'string' || !term) return [];
  const forms = new Set();
  const add = (value) => {
    const trimmed = value.trim();
    if (trimmed && hasSearchableChars(trimmed)) forms.add(trimmed);
  };
  const expanded = expand(term);
  for (const base of new Set([term, expanded])) {
    add(base);
    for (const intensity of SEARCH_INTENSITIES) add(compress(base, { intensity }));
  }
  return Array.from(forms);
}

/** @param {string} query @returns {string[]} */
function queryForms(query) {
  if (typeof query !== 'string' || !query) return [];
  return Array.from(new Set(query.split(/\s+/).filter(Boolean).flatMap(termForms)));
}

/** @param {string} value @returns {string} */
function ftsQuote(value) { return `"${value.replace(/"/g, '""')}"`; }

/** @param {string} query @returns {string} */
function buildAndMatch(query) {
  if (typeof query !== 'string' || !query) return '';
  return query.split(/\s+/).filter(Boolean)
    .map(termForms)
    .filter(forms => forms.length > 0)
    .map(forms => forms.length === 1 ? ftsQuote(forms[0]) : `(${forms.map(ftsQuote).join(' OR ')})`)
    .join(' AND ');
}

/** @param {string[][]} groups @returns {string} */
function buildOrMatch(groups) {
  return groups
    .filter(forms => forms.length > 0)
    .map(forms => `(${forms.map(ftsQuote).join(' OR ')})`)
    .join(' OR ');
}

module.exports = {
  LEXICON, compress, expand, countTokens, compressProse,
  hasSearchableChars, termForms, queryForms, ftsQuote, buildAndMatch, buildOrMatch
};
