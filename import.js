"use strict";
/* Stats file import: CSV and Excel (.xlsx) -> game entries for the ledger. Pure functions, no DOM, no dependencies
   (the .xlsx reader is a small zip + XML reader built on the browser's DecompressionStream).
   Accepted layouts:
     - a workbook shaped like our Google Sheet: one tab per player, the tab name is the player;
     - or any CSV / tab with a Player column.
   Required columns: Map, Date, Kills, Death(s), Assist(s), Rounds and DMG (or ADR). Optional: HS %, Player, Team, Result (W/L). */

/* ----- CSV ----- */
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] || "";
  const delim = [",", ";", "\t"].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ""));
}

/* ----- xlsx (zip + XML) ----- */
const u16 = (b, o) => b[o] | b[o + 1] << 8;
const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
async function inflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function unzip(buf) {
  const b = new Uint8Array(buf); let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("this is not an .xlsx (zip) file; old .xls files are not supported, save it as .xlsx or .csv");
  const n = u16(b, e + 10); let p = u32(b, e + 16); const out = {};
  for (let k = 0; k < n; k++) {
    if (u32(b, p) !== 0x02014b50) throw new Error("the .xlsx file looks corrupted");
    const method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), off = u32(b, p + 42);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    const start = off + 30 + u16(b, off + 26) + u16(b, off + 28), data = b.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Error("unsupported zip compression in the .xlsx file");
    out[name] = method === 0 ? data : await inflateRaw(data);
  }
  return out;
}
const xmlText = u8 => new TextDecoder().decode(u8);
const unxml = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k === "amp") return "&"; if (k === "lt") return "<"; if (k === "gt") return ">"; if (k === "quot") return '"'; if (k === "apos") return "'";
  return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : +k.slice(1));
});
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : null; };
const colIndex = ref => { let n = 0; for (const ch of /^[A-Z]+/i.exec(ref)[0].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

// -> [{name, rows: [[cell, ...], ...]}]; text cells are strings, numeric cells are numbers.
async function parseXlsx(buf) {
  const z = await unzip(buf);
  if (!z["xl/workbook.xml"]) throw new Error("no workbook found in this .xlsx file");
  const sst = z["xl/sharedStrings.xml"]
    ? [...xmlText(z["xl/sharedStrings.xml"]).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
        .map(m => unxml([...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join("")))
    : [];
  const rels = {};
  for (const m of xmlText(z["xl/_rels/workbook.xml.rels"] || new Uint8Array()).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id"), t = attr(m[0], "Target");
    if (id && t) rels[id] = "xl/" + t.replace(/^\/?(xl\/)?/, "");
  }
  const sheets = [];
  for (const m of xmlText(z["xl/workbook.xml"]).matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name"), rid = attr(m[0], "r:id") || attr(m[0], "id"), file = rels[rid];
    if (!name || !z[file]) continue;
    const rows = [];
    for (const r of xmlText(z[file]).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], "r"), t = attr(c[1], "t"), inner = c[2] || "";
        if (!ref) continue;
        let val = "";
        if (t === "inlineStr") val = unxml([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(""));
        else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (v) val = t === "s" ? (sst[+v[1]] ?? "") : t === "str" || t === "e" ? unxml(v[1]) : t === "b" ? v[1] === "1" : (Number.isFinite(+v[1]) ? +v[1] : unxml(v[1]));
        }
        cells[colIndex(ref)] = val;
      }
      rows.push(Array.from(cells, v => v ?? ""));
    }
    sheets.push({name, rows: rows.filter(r => r.some(x => String(x).trim() !== ""))});
  }
  return sheets;
}

/* ----- table -> stat rows ----- */
const STAT_COLS = {
  player: "player", name: "player", map: "map", date: "date", team: "team", result: "result", win: "result",
  kills: "k", kill: "k", k: "k", death: "d", deaths: "d", d: "d", assist: "a", assists: "a", a: "a",
  hs: "hs", hspct: "hs", headshot: "hs", headshots: "hs", dmg: "dmg", damage: "dmg", rounds: "rounds", round: "rounds", adr: "adr",
};
const canonCol = h => STAT_COLS[String(h).toLowerCase().replace(/%/g, "pct").replace(/[^a-z]/g, "")];
function statHeader(first) {
  const cols = {};
  first.forEach((h, i) => { const c = canonCol(h); if (c && !(c in cols)) cols[c] = i; });
  const need = ["map", "date", "k", "d", "a", "rounds"];
  return need.every(c => c in cols) && ("dmg" in cols || "adr" in cols) ? cols : null;
}
function normDate(v) {
  if (typeof v === "number") {
    if (v < 20000 || v > 80000) return null;                       // not an Excel serial date
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 864e5).toISOString().slice(0, 10);
  }
  const s = String(v).trim(); let m;
  const iso = (y, mo, d) => (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) ? `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
  if ((m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s))) return iso(m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) return iso(m[3].length === 2 ? "20" + m[3] : m[3], +m[1], +m[2]);
  if ((m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
    const mo = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ").indexOf(m[1].toLowerCase()) + 1;
    return mo ? iso(m[3], mo, +m[2]) : null;
  }
  return null;
}
const numOf = v => typeof v === "number" ? v : parseFloat(String(v).replace(/[%,\s]/g, ""));
function resultOf(v) {
  const s = String(v).trim().toLowerCase();
  if (["w", "win", "won", "1", "true", "yes"].includes(s)) return true;
  if (["l", "loss", "lost", "lose", "0", "false", "no"].includes(s)) return false;
  return null;
}

// -> null when the table has no stats header, else {rows: [valid rows], invalid: [{line, why}]}
function tableToStatRows(table, defaultPlayer) {
  if (!table.length) return null;
  const cols = statHeader(table[0]);
  if (!cols) return null;
  const rows = [], invalid = [];
  table.slice(1).forEach((line, idx) => {
    const at = c => (c in cols ? line[cols[c]] ?? "" : "");
    const lineNo = idx + 2, why = [];
    const name = String("player" in cols ? at("player") : defaultPlayer || "").trim();
    const map = String(at("map")).trim(), date = normDate(at("date"));
    if (!name) why.push("no player (add a Player column, or the tab/file name is used)");
    if (!map) why.push("no map");
    if (!date) why.push(`unreadable date "${at("date")}"`);
    const k = numOf(at("k")), d = numOf(at("d")), a = numOf(at("a")), rounds = numOf(at("rounds"));
    for (const [label, v] of [["kills", k], ["deaths", d], ["assists", a]]) if (!(v >= 0)) why.push(`bad ${label}`);
    if (!(rounds > 0)) why.push("bad rounds");
    let dmg = "dmg" in cols ? numOf(at("dmg")) : numOf(at("adr")) * rounds;
    if (!(dmg >= 0)) why.push("bad damage/ADR");
    const hsRaw = at("hs");
    let hs = hsRaw === "" ? 0 : numOf(hsRaw);
    if (typeof hsRaw === "number" && hsRaw <= 1) hs *= 100;          // Excel stores 33% as 0.33
    if (!(hs >= 0 && hs <= 100)) why.push("bad HS %");
    if (why.length) { invalid.push({line: lineNo, why: why.join("; ")}); return; }
    const row = {name, date, map, k: Math.round(k), d: Math.round(d), a: Math.round(a), hs: Math.round(hs * 10) / 10, dmg: Math.round(dmg), rounds: Math.round(rounds)};
    const team = String(at("team")).trim(); if (team) row.team = team;
    const win = "result" in cols ? resultOf(at("result")) : null; if (win !== null) row.win = win;
    rows.push(row);
  });
  return {rows, invalid};
}

// Read one uploaded file into {sources: [{file, tab, player, needsPlayer, table}], skipped: [string]}.
async function readStatsFile(name, bytes) {
  const lower = name.toLowerCase(), base = name.replace(/\.[^.]+$/, "");
  if (lower.endsWith(".xls")) throw new Error(`${name}: old .xls files are not supported, save it as .xlsx or .csv`);
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) {
    const table = parseCsv(new TextDecoder().decode(bytes));
    const cols = table.length ? statHeader(table[0]) : null;
    return cols ? {sources: [{file: name, tab: null, player: base, needsPlayer: !("player" in cols), table}], skipped: []}
                : {sources: [], skipped: [`${name}: no stats header found (needs Map, Date, Kills, Death, Assist, Rounds and DMG or ADR)`]};
  }
  const sources = [], skipped = [];
  for (const s of await parseXlsx(bytes)) {
    const cols = s.rows.length ? statHeader(s.rows[0]) : null;
    if (cols) sources.push({file: name, tab: s.name, player: s.name, needsPlayer: !("player" in cols), table: s.rows});
    else skipped.push(`${name} → tab "${s.name}": not a stats tab`);
  }
  return {sources, skipped};
}

/* ----- analysis against what the site already has ----- */
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
const sameStats = (x, y) => x.k === y.k && x.d === y.d && x.a === y.a && x.rounds === y.rounds && Math.abs(x.dmg - y.dmg) <= 1;

// sources: [{file, tab, player, table}]; existing: Map("name|date|map" -> row); known: [names]; mapName: normaliser
function analyzeStats(sources, existing, known, mapName = m => m) {
  const knownByLower = new Map(known.map(n => [n.toLowerCase(), n]));
  const groups = new Map(), counts = {read: 0, fresh: 0, same: 0, conflict: 0, invalid: 0};
  const invalid = [], conflicts = [], notes = [], seen = new Map();
  for (const src of sources) {
    const r = tableToStatRows(src.table, src.player);
    if (!r) continue;
    const where = src.tab ? `${src.file} → ${src.tab}` : src.file;
    counts.invalid += r.invalid.length;
    r.invalid.forEach(x => invalid.push(`${where}, row ${x.line}: ${x.why}`));
    for (const row of r.rows) {
      counts.read++;
      const spelled = knownByLower.get(row.name.toLowerCase());
      if (spelled && spelled !== row.name) { notes.push(`"${row.name}" was matched to the existing player "${spelled}"`); row.name = spelled; }
      row.map = mapName(row.map);
      const key = `${row.name}|${row.date}|${row.map}`;
      const prev = seen.get(key) || existing.get(key);
      if (prev) {
        if (sameStats(prev, row)) counts.same++;
        else { counts.conflict++; conflicts.push({key, name: row.name, date: row.date, map: row.map, have: prev, got: row, inFile: seen.has(key)}); }
        continue;
      }
      seen.set(key, row); counts.fresh++;
      const gk = `${row.date}|${row.map}`;
      if (!groups.has(gk)) groups.set(gk, {date: row.date, map: row.map, players: []});
      groups.get(gk).players.push(row);
    }
  }
  const knownLower = new Set(known.map(n => n.toLowerCase()));
  const newPlayers = [...new Set([...groups.values()].flatMap(g => g.players.map(p => p.name)).filter(n => !knownLower.has(n.toLowerCase())))];
  const games = [...groups.values()].sort((a, b) => b.date.localeCompare(a.date) || a.map.localeCompare(b.map)).map(g => {
    const rc = {}; g.players.forEach(p => { rc[p.rounds] = (rc[p.rounds] || 0) + 1; });
    const rounds = +Object.entries(rc).sort((a, b) => b[1] - a[1])[0][0];
    const players = g.players.map(p => { const o = {name: p.name, k: p.k, d: p.d, a: p.a, hs: p.hs, dmg: p.dmg, rounds: p.rounds}; if (p.team) o.team = p.team; if ("win" in p) o.win = p.win; return o; });
    const canon = JSON.stringify(players.map(p => [p.name, p.k, p.d, p.a, p.dmg, p.rounds]).sort());
    return {entry: {kind: "stats", id: `stats-${g.date}-${g.map.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${fnv(canon)}`, date: g.date, map: g.map, rounds, source: "upload", players},
            mixedRounds: Object.keys(rc).length > 1};
  });
  return {games, counts, invalid, conflicts, notes: [...new Set(notes)], newPlayers};
}

if (typeof module !== "undefined") module.exports = {parseCsv, parseXlsx, tableToStatRows, statHeader, normDate, analyzeStats, readStatsFile};
