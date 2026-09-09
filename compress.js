// caipira/compress.js — EXACT port of cavemem compress/expand/tokenize
// From @cavemem/compress — boundary-protected prose compression
// Stays out of code blocks, URLs, paths, identifiers, versions, etc.

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
  { kind: "path", priority: 60, re: /(?:(?:\.{1,2})?\/[A-Za-z0-9._\-/]+|~\/[A-Za-z0-9._\-/]+|[A-Z]:\\[A-Za-z0-9._\-\\]+)/g },
  { kind: "date", priority: 50, re: /\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?\b/g },
  { kind: "version", priority: 40, re: /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/g },
  { kind: "number", priority: 30, re: /\b\d+(?:\.\d+)?\b/g },
  { kind: "identifier", priority: 20, re: /\b[A-Za-z_][A-Za-z0-9_]*[-_][A-Za-z0-9_\-]+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g }
];

function tokenize(input) {
  const spans = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m = rule.re.exec(input);
    while (m !== null) {
      if (m[0].length === 0) { rule.re.lastIndex += 1; }
      else { spans.push({ start: m.index, end: m.index + m[0].length, kind: rule.kind, priority: rule.priority }); }
      m = rule.re.exec(input);
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
function expand(input) {
  const segments = tokenize(input);
  const map = expansions();
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return input;
  const pattern = new RegExp(`\\b(?:${keys.map(escapeRe).join("|")})\\b`, "gi");
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

function escapeRe2(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function removePhrases(text, phrases) {
  if (phrases.length === 0) return text;
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`\\b(?:${sorted.map(escapeRe2).join("|")})\\b`, "gi");
  return text.replace(pattern, "");
}
function abbreviate(text, map) {
  let result = text;
  for (const [from, to] of Object.entries(map)) {
    const re = new RegExp(`\\b${escapeRe2(from)}\\b`, "gi");
    result = result.replace(re, (match) => matchCase(match, to));
  }
  return result;
}
function collapseWhitespace(text) {
  return text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/ +([.,;:!?])/g, "$1").replace(/\n{3,}/g, "\n\n").replace(/^ +| +$/gm, "");
}
function compressProse(text, intensity) {
  const leadingMatch = text.match(/^\s+/);
  const trailingMatch = text.match(/\s+$/);
  const leading = leadingMatch ? leadingMatch[0] : "";
  const trailing = trailingMatch ? trailingMatch[0] : "";
  const body = text.slice(leading.length, text.length - trailing.length);
  if (body.length === 0) return text;
  let out = body;
  out = removePhrases(out, pleasantriesFor(intensity));
  out = removePhrases(out, hedgesFor(intensity));
  out = removePhrases(out, fillersFor(intensity));
  out = removePhrases(out, articlesFor(intensity));
  out = abbreviate(out, abbreviationsFor(intensity));
  out = collapseWhitespace(out);
  const leftPad = leading.includes("\n") ? "\n" : leading ? " " : "";
  const rightPad = trailing.includes("\n") ? "\n" : trailing ? " " : "";
  return `${leftPad}${out}${rightPad}`;
}
function compress(input, opts = {}) {
  const intensity = opts.intensity ?? "full";
  const segments = tokenize(input);
  const out = [];
  for (const seg of segments) {
    if (seg.preserved) { out.push(seg.text); continue; }
    out.push(compressProse(seg.text, intensity));
  }
  return out.join("").replace(/[ \t]+([.,;:!?])/g, "$1");
}

// ── COUNT ──

function countTokens(text) {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  return Math.max(words, Math.round(chars / 4));
}

module.exports = { compress, expand, countTokens, compressProse };
