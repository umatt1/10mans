const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const {parseCsv, parseXlsx, tableToStatRows, statHeader, normDate, analyzeStats, readStatsFile} = require("../import.js");

/* ---- a tiny .xlsx writer so the reader is tested against a real zip, not a mock ---- */
const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) { // files: {name: [string, "store"|"deflate"]}
  const parts = [], central = []; let off = 0;
  for (const [name, [text, how]] of Object.entries(files)) {
    const raw = Buffer.from(text), data = how === "store" ? raw : zlib.deflateRawSync(raw), nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(how === "store" ? 0 : 8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(how === "store" ? 0 : 8, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, data); central.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const serial = iso => (Date.UTC(...iso.split("-").map((x, i) => i === 1 ? x - 1 : +x)) - Date.UTC(1899, 11, 30)) / 864e5;
const cellS = (ref, i) => `<c r="${ref}" t="s"><v>${i}</v></c>`, cellN = (ref, n) => `<c r="${ref}"><v>${n}</v></c>`, cellI = (ref, s) => `<c r="${ref}" t="inlineStr"><is><t>${s}</t></is></c>`;
function workbook() {
  const sst = ["Map", "Date", "Kills", "Death", "Assist", "HS %", "DMG", "Rounds", "Nuke", "Name", "Rating", "Matt &amp; Co"];
  const head = `<row r="1">${["Map", "Date", "Kills", "Death", "Assist", "HS %", "DMG", "Rounds"].map((_, i) => cellS(String.fromCharCode(65 + i) + "1", i)).join("")}</row>`;
  const sheet1 = `<worksheet><sheetData>${head}<row r="2">${cellS("A2", 8)}${cellN("B2", serial("2026-11-07"))}${cellN("C2", 20)}${cellN("D2", 12)}${cellN("E2", 4)}${cellN("F2", 0.45)}${cellN("G2", 2150)}${cellN("H2", 22)}</row></sheetData></worksheet>`;
  const hI = ["Map", "Date", "Kills", "Death", "Assist", "HS %", "DMG", "Rounds"].map((s, i) => cellI(String.fromCharCode(65 + i) + "1", s)).join("");
  const sheet2 = `<worksheet><sheetData><row r="1">${hI}</row><row r="2">${cellI("A2", "Mirage")}${cellI("B2", "11/7/26")}${cellN("C2", 8)}${cellN("D2", 7)}${cellN("E2", 3)}${cellI("F2", "33%")}${cellN("G2", 1200)}${cellN("H2", 22)}</row></sheetData></worksheet>`;
  const sheet3 = `<worksheet><sheetData><row r="1">${cellS("A1", 9)}${cellS("C1", 10)}${cellS("D1", 11)}</row></sheetData></worksheet>`;
  return zip({
    "xl/workbook.xml": [`<workbook xmlns:r="x"><sheets><sheet name="Matt" sheetId="1" r:id="rId1"/><sheet name="New &amp; Co" sheetId="2" r:id="rId2"/><sheet name="Leaderboards" sheetId="3" r:id="rId3"/></sheets></workbook>`, "deflate"],
    "xl/_rels/workbook.xml.rels": [`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>`, "deflate"],
    "xl/sharedStrings.xml": [`<sst>${sst.map(s => `<si><t>${s}</t></si>`).join("")}</sst>`, "store"],
    "xl/worksheets/sheet1.xml": [sheet1, "deflate"], "xl/worksheets/sheet2.xml": [sheet2, "store"], "xl/worksheets/sheet3.xml": [sheet3, "deflate"],
  });
}
const ab = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

/* ---- CSV ---- */
test("CSV: quotes, embedded commas/newlines, CRLF, BOM, blank lines, semicolon delimiter", () => {
  assert.deepEqual(parseCsv('﻿a,b,c\r\n1,"x, y",3\r\n\r\n"line\nbreak","say ""hi""",z\r\n'), [["a", "b", "c"], ["1", "x, y", "3"], ["line\nbreak", 'say "hi"', "z"]]);
  assert.deepEqual(parseCsv("Map;Date;Kills\nNuke;3/28/26;18"), [["Map", "Date", "Kills"], ["Nuke", "3/28/26", "18"]]);
  assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
});

/* ---- dates ---- */
test("dates: m/d/yy, m/d/yyyy, ISO, 'Oct 17, 2026', Excel serials; junk is rejected", () => {
  for (const [v, want] of [["3/28/26", "2026-03-28"], ["3/28/2026", "2026-03-28"], ["2026-03-28", "2026-03-28"], ["2026/3/8", "2026-03-08"], ["Oct 17, 2026", "2026-10-17"], ["October 17 2026", "2026-10-17"], [serial("2026-11-07"), "2026-11-07"]])
    assert.equal(normDate(v), want, String(v));
  for (const bad of ["", "tomorrow", "13/45/26", "2026-13-01", 5, 123456]) assert.equal(normDate(bad), null, String(bad));
});

/* ---- header + row parsing ---- */
const H = ["Map", "Date", "Kills", "Death", "Assist", "HS %", "DMG", "Rounds"];
test("headers: aliases and any order; missing required columns are rejected", () => {
  assert.ok(statHeader(["rounds", "dmg", "Assists", "Deaths", "Kills", "date", "MAP"]));
  assert.ok(statHeader(["Player", "Map", "Date", "K", "D", "A", "ADR", "Rounds"]), "ADR may stand in for DMG");
  assert.equal(statHeader(["Map", "Date", "Kills", "Death", "Assist", "Rounds"]), null, "needs DMG or ADR");
  assert.equal(statHeader(["Name", "Rating"]), null);
});
test("rows: text and Excel number conventions for HS%, ADR-only, team/result, and per-row reasons for bad rows", () => {
  const r = tableToStatRows([H, ["Nuke", "3/28/26", "18", "15", "6", "33%", "1728", "21"], ["Mirage", "11/7/26", 8, 7, 3, 0.45, 1200, 22], ["", "x", -1, "a", 1, "5", 1, 0]], "Matt");
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].hs, 33); assert.equal(r.rows[1].hs, 45, "numeric 0.45 is Excel's 45%");
  assert.equal(r.rows[0].name, "Matt");
  assert.equal(r.invalid.length, 1);
  assert.match(r.invalid[0].why, /no map/); assert.match(r.invalid[0].why, /unreadable date/); assert.match(r.invalid[0].why, /bad kills/); assert.match(r.invalid[0].why, /bad rounds/);
  const adr = tableToStatRows([["Player", "Map", "Date", "Kills", "Death", "Assist", "ADR", "Rounds", "Team", "Result"], ["Will", "Nuke", "2026-11-07", 10, 5, 2, 80, 20, "T1", "W"], ["Max", "Nuke", "2026-11-07", 5, 10, 1, 40, 20, "T2", "loss"]]);
  assert.equal(adr.rows[0].dmg, 1600); assert.equal(adr.rows[0].team, "T1"); assert.equal(adr.rows[0].win, true); assert.equal(adr.rows[1].win, false);
});

/* ---- xlsx ---- */
test("xlsx: reads shared and inline strings, Excel dates, stored+deflated parts, entities, absolute rel targets, gaps", async () => {
  const sheets = await parseXlsx(ab(workbook()));
  assert.deepEqual(sheets.map(s => s.name), ["Matt", "New & Co", "Leaderboards"]);
  const r1 = tableToStatRows(sheets[0].rows, sheets[0].name).rows[0];
  assert.deepEqual([r1.name, r1.map, r1.date, r1.k, r1.hs, r1.dmg], ["Matt", "Nuke", "2026-11-07", 20, 45, 2150]);
  const r2 = tableToStatRows(sheets[1].rows, sheets[1].name).rows[0];
  assert.deepEqual([r2.name, r2.map, r2.date, r2.hs], ["New & Co", "Mirage", "2026-11-07", 33]);
  assert.deepEqual(sheets[2].rows[0], ["Name", "", "Rating", "Matt & Co"], "an empty column between cells is kept and &amp; is decoded");
});
test("readStatsFile: workbook tabs become players, helper tabs are listed as skipped; CSV uses the file name; .xls and garbage are explained", async () => {
  const w = await readStatsFile("season.xlsx", new Uint8Array(workbook()));
  assert.deepEqual(w.sources.map(s => s.player), ["Matt", "New & Co"]);
  assert.equal(w.sources.every(s => s.needsPlayer), true);
  assert.match(w.skipped[0], /Leaderboards.*not a stats tab/);
  const c = await readStatsFile("Matt.csv", new TextEncoder().encode(H.join(",") + "\nNuke,3/28/26,18,15,6,33%,1728,21"));
  assert.equal(c.sources[0].player, "Matt"); assert.equal(c.sources[0].needsPlayer, true);
  const withP = await readStatsFile("all.csv", new TextEncoder().encode("Player," + H.join(",") + "\nWill,Nuke,3/28/26,18,15,6,33%,1728,21"));
  assert.equal(withP.sources[0].needsPlayer, false);
  assert.match((await readStatsFile("x.csv", new TextEncoder().encode("a,b\n1,2"))).skipped[0], /no stats header/);
  await assert.rejects(readStatsFile("old.xls", new Uint8Array(4)), /\.xls files are not supported/);
  await assert.rejects(readStatsFile("bad.xlsx", new Uint8Array(100)), /not an \.xlsx/);
});

/* ---- analysis against existing data ---- */
const row = (k, d, a, dmg, rounds = 20) => ({k, d, a, dmg, rounds, hs: 0});
const existing = new Map([["Matt|2026-03-28|Nuke", row(18, 15, 6, 1728, 21)]]);
const src = (csv, player = "x") => ({file: "f.csv", tab: null, player, table: parseCsv(csv)});
test("analysis: new vs already-there vs conflicting vs unreadable, new players, name casing, in-file duplicates", () => {
  const csv = ["Player," + H.join(","),
    "matt,Nuke,3/28/26,18,15,6,33%,1728,21",       // identical to the site (and 'matt' is matched to 'Matt')
    "Matt,Mirage,3/28/26,9,9,2,10%,1000,20",       // new row for a known player
    "Newbie,Mirage,3/28/26,12,8,3,40%,1500,20",    // new player
    "Newbie,Mirage,3/28/26,99,8,3,40%,1500,20",    // same player/game, different numbers, earlier in this upload
    "Will,Nuke,not a date,1,1,1,1%,1,1"].join("\n");
  const A = analyzeStats([src(csv)], existing, ["Matt", "Will"]);
  assert.deepEqual(A.counts, {read: 4, fresh: 2, same: 1, conflict: 1, invalid: 1});
  assert.deepEqual(A.newPlayers, ["Newbie"]);
  assert.match(A.notes[0], /"matt".*"Matt"/);
  assert.equal(A.conflicts[0].inFile, true);
  assert.equal(A.games.length, 1, "only genuinely new rows make a game");
  assert.deepEqual(A.games[0].entry.players.map(p => p.name).sort(), ["Matt", "Newbie"]);
  assert.equal(A.games[0].entry.kind, "stats");
});
test("analysis: a row that differs from the site is reported and never added", () => {
  const A = analyzeStats([src("Player," + H.join(",") + "\nMatt,Nuke,3/28/26,19,15,6,33%,1728,21")], existing, ["Matt"]);
  assert.equal(A.counts.conflict, 1); assert.equal(A.games.length, 0);
  assert.equal(A.conflicts[0].have.k, 18); assert.equal(A.conflicts[0].got.k, 19);
});
test("analysis: ids are stable for the same data and change when the data changes; rounds use the most common value", () => {
  const csv = "Player," + H.join(",") + "\nA,Dust,11/7/26,10,5,2,10%,1000,22\nB,Dust,11/7/26,8,9,2,10%,900,22\nC,Dust,11/7/26,7,9,2,10%,800,21";
  const a = analyzeStats([src(csv)], new Map(), [], m => (m === "Dust" ? "Dust2" : m)), b = analyzeStats([src(csv)], new Map(), []);
  assert.equal(a.games[0].entry.map, "Dust2");
  assert.equal(a.games[0].entry.rounds, 22); assert.equal(a.games[0].mixedRounds, true);
  assert.equal(analyzeStats([src(csv)], new Map(), [], m => (m === "Dust" ? "Dust2" : m)).games[0].entry.id, a.games[0].entry.id);
  assert.notEqual(analyzeStats([src(csv.replace("1000", "1001"))], new Map(), []).games[0].entry.id, b.games[0].entry.id);
  assert.match(a.games[0].entry.id, /^stats-2026-11-07-dust2-[0-9a-f]{8}$/);
});

/* ---- the edge function's validation (TypeScript source, type annotations stripped) ---- */
test("edge function: stats validation and id/cleaning rules", async () => {
  const ts = fs.readFileSync(path.join(__dirname, "../supabase/functions/ingest-match/index.ts"), "utf8");
  const grab = name => { const i = ts.indexOf(`export ${name}`); const j = ts.indexOf("\n}\n", i); return ts.slice(i + 7, j + 3); };
  const strip = s => s.replace(/\(([a-z]): any\)/g, "($1)").replace(/\(x: any\)/g, "(x)").replace(/\(p: any\)/g, "(p)").replace(/: string\[\]/g, "").replace(/const o: any/, "const o").replace(/: any/g, "");
  const {problems, cleanStats} = new Function(`${strip(grab("function problems"))}\n${strip(grab("async function cleanStats"))}\nreturn {problems, cleanStats};`)();
  const ok = {kind: "stats", date: "2026-11-07", map: "Nuke", rounds: 22, players: [{name: " Matt ", k: 1, d: 2, a: 3, dmg: 100, rounds: 22, hs: 40, team: "T1", win: true, evil: "<script>"}]};
  assert.deepEqual(problems(ok), []);
  assert.ok(problems({...ok, date: "11/7/26"}).length); assert.ok(problems({...ok, players: []}).length); assert.ok(problems({...ok, players: Array(61).fill(ok.players[0])}).length);
  assert.ok(problems({...ok, players: [{name: "A", k: 1, d: 1, a: 1, dmg: 1}]}).length, "rounds required");
  assert.ok(problems({...ok, players: [{name: "A", k: -1, d: 1, a: 1, dmg: 1, rounds: 1}]}).length, "negative rejected");
  assert.ok(problems({...ok, players: [{name: "x".repeat(41), k: 1, d: 1, a: 1, dmg: 1, rounds: 1}]}).length, "long names rejected");
  assert.deepEqual(problems({date: "2026-11-07", map: "Nuke", score: [13, 9]}), [], "ordinary matches still validate");
  const c = await cleanStats(ok), c2 = await cleanStats(JSON.parse(JSON.stringify(ok)));
  assert.equal(c.players[0].name, "Matt"); assert.equal("evil" in c.players[0], false, "unknown fields are dropped");
  assert.equal(c.id, c2.id); assert.match(c.id, /^stats-2026-11-07-nuke-[0-9a-f]{10}$/);
  assert.notEqual((await cleanStats({...ok, players: [{...ok.players[0], k: 2}]})).id, c.id);
});
