"use strict";
/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const f = (v, p = 2) => Number.isFinite(v) ? v.toFixed(p) : "–";
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const MON = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const fdate = d => { const [y, m, dd] = d.split("-"); return `${MON[+m - 1]} ${+dd}, ${y}`; };
const day = d => Date.parse(d) / 864e5;
const tmin = t => { const m = /(\d+):(\d+)\s*([AP]M)/i.exec(t || ""); return m ? ((+m[1] % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0)) * 60 + +m[2] : null; };
const normMap = m => m === "Dust" ? "Dust2" : m;
const pl = n => `<a class="pl" href="#p/${encodeURIComponent(n)}">${esc(n)}</a>`;
const rc = v => v >= 1.1 ? "rg" : v < 0.9 ? "rr" : "rn";
const rt = v => `<span class="${rc(v)}">${f(v)}</span>`;
const sgn = v => `<span class="${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${v > 0 ? "+" : ""}${v}</span>`;
const mean = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : NaN;
const std = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(mean(a.map(x => (x - m) ** 2))) : 0; };
const COLORS = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"].map(v => `var(${v})`);

function download(name, text, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const cell = v => { v = String(v ?? ""); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCsv = (head, rows) => [head, ...rows].map(r => r.map(cell).join(",")).join("\n");
const ROW_HEAD = ["date", "map", "player", "team", "result", "kills", "deaths", "assists", "adr", "hs_pct", "rating", "kast", "rounds"];
const rowCsv = r => [r.date, r.map, r.name, r.team || "", r.win == null ? "" : r.win ? "win" : "loss", r.k, r.d, r.a, f(r.adr), r.hs, f(rowRating(r)), r.kast ?? "", r.rounds];

/* ---------- state ---------- */
// config.js picks where match data comes from: static JSON files (GitHub Pages) or Supabase (Vercel).
const CFG = window.TENMANS || {};
const SB = CFG.mode === "supabase" && CFG.supabaseUrl && CFG.supabaseAnonKey;
let SESSION = store.get("sb", null);
let SHEET, REF, DB;
let LOCAL = store.get("local", []);
let SRC = store.get("src", "sheet");
const FILT = {day: "", map: "", min: 1};
const SORT = {};
let PEND = [];
let BUSY = false;

const RL = () => SRC === "refrag" ? "Rating" : "Rating*";
const alias = n => REF.aliases[n] || n;

/* ---------- rating & aggregation ---------- */
// HLTV-2.0-style estimate; KAST and impact are not in the sheet so they are approximated.
const estRating = (kpr, dpr, apr, adr) =>
  0.0073 * 70 + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * (2.13 * kpr + 0.42 * apr - 0.41) + 0.0032 * adr + 0.1587;
const rowRating = r => r.rating ?? estRating(r.k / r.rounds, r.d / r.rounds, r.a / r.rounds, r.adr);

function agg(rows) {
  const n = rows.length, S = k => rows.reduce((t, r) => t + (r[k] || 0), 0);
  const R = S("rounds") || 1, k = S("k"), d = S("d"), a = S("a"), dmg = S("dmg");
  const kpr = k / R, dpr = d / R, apr = a / R, adr = dmg / R;
  const rs = rows.map(rowRating);
  const official = n && rows.every(r => r.rating != null);
  const kast = rows.filter(r => r.kast != null);
  const wl = rows.filter(r => r.win != null), wins = wl.filter(r => r.win).length;
  return {
    n, k, d, a, kpr, dpr, apr, adr, rounds: R, kd: k / (d || 1),
    hs: k ? rows.reduce((t, r) => t + r.hs * r.k, 0) / k : 0,
    rating: official ? mean(rs) : estRating(kpr, dpr, apr, adr),
    kast: kast.length ? mean(kast.map(r => r.kast)) : null,
    played: wl.length, wins, winPct: wl.length ? wins / wl.length * 100 : null,
    sd: std(rs), best: rs.length ? Math.max(...rs) : NaN, worst: rs.length ? Math.min(...rs) : NaN,
  };
}

/* ---------- build the working dataset for the current source ---------- */
function sbRows(m) {
  const R = m.score[0] + m.score[1];
  return [["win", m.win], ["lose", m.lose]].flatMap(([side, ps]) => ps.map(p => ({
    name: alias(p.name), ingame: p.name, date: m.date, map: normMap(m.map), k: p.k, d: p.d, a: p.a, hs: p.hs ?? 0,
    rounds: R, dmg: (p.adr ?? 0) * R, adr: p.adr ?? 0, rating: p.rating ?? null, kast: p.kast ?? null, roles: p.roles || [], side,
  })));
}

function buildDB() {
  const refs = [...REF.matches, ...LOCAL.filter(l => !REF.matches.some(m => m.id === l.id))].map(m => ({...m, map: normMap(m.map)}));
  let games = [];
  if (SRC === "sheet") {
    const g = {};
    for (const [name, rows] of Object.entries(SHEET.players)) for (const r of rows) {
      const map = normMap(r.map);
      (g[r.date + "|" + map] ??= {date: r.date, map, rows: []}).rows.push(
        {name, date: r.date, map, k: r.k, d: r.d, a: r.a, hs: r.hs, rounds: r.rounds, dmg: r.dmg, adr: r.dmg / r.rounds});
    }
    // A stray row dated a day off from its map is folded into the real game.
    for (const k of Object.keys(g)) {
      const x = g[k];
      if (!x || x.rows.length > 2) continue;
      const t = Object.values(g).find(y => y !== x && y.map === x.map && y.rows.length > 2 &&
        Math.abs(day(y.date) - day(x.date)) <= 1 && !y.rows.some(r => x.rows.some(q => q.name === r.name)));
      if (t) { t.rows.push(...x.rows); delete g[k]; }
    }
    games = Object.values(g);
    const used = new Set();
    games.forEach(x => {
      const rounds = x.rows[0].rounds;
      const i = refs.findIndex((m, j) => !used.has(j) && m.map === x.map && Math.abs(day(m.date) - day(x.date)) <= 1 &&
        m.score[0] + m.score[1] === rounds);
      if (i >= 0) { used.add(i); x.ref = refs[i]; }
    });
    refs.forEach((m, j) => { if (!used.has(j)) games.push({date: m.date, map: m.map, ref: m, rows: m.win ? sbRows(m) : []}); });
  } else {
    games = refs.map(m => ({date: m.date, map: m.map, ref: m, rows: m.win ? sbRows(m) : []}));
  }
  const order = (a, b) => (tmin(a.ref?.time) ?? 9999) - (tmin(b.ref?.time) ?? 9999) || a.map.localeCompare(b.map);
  games.sort((a, b) => a.date.localeCompare(b.date) || order(a, b));
  games.forEach((g, i) => { g.i = i; g.score = g.ref?.score || null; g.rows.forEach(r => r.g = i); });

  // Teams: the first scoreboard of a Scrim day fixes the two rosters; later games are matched against them.
  const series = {};
  const byDate = {};
  games.forEach(g => (byDate[g.date] ??= []).push(g));
  for (const [date, gs] of Object.entries(byDate)) {
    const full = gs.filter(g => g.ref?.win);
    if (!full.length) continue;
    const A = new Set(full[0].ref.win.map(p => alias(p.name))), B = new Set(full[0].ref.lose.map(p => alias(p.name)));
    const wins = {A: 0, B: 0};
    for (const g of full) {
      const w = g.ref.win.map(p => alias(p.name));
      g.winner = w.filter(n => A.has(n)).length >= w.filter(n => B.has(n)).length ? "A" : "B";
      wins[g.winner]++;
      g.rows.forEach(r => { r.team = A.has(r.name) ? "A" : B.has(r.name) ? "B" : null; r.win = r.team ? r.team === g.winner : (r.side ? r.side === "win" : null); });
    }
    series[date] = {A: [...A], B: [...B], wins, games: full.length};
  }
  const rows = games.flatMap(g => g.rows);
  const players = {};
  rows.forEach(r => (players[r.name] ??= []).push(r));
  const pagg = Object.fromEntries(Object.entries(players).map(([n, rs]) => [n, agg(rs)]));
  const days = [...new Set(games.map(g => g.date))].sort().reverse();
  const maps = [...new Set(games.map(g => g.map))].sort();
  DB = {games, rows, players, pagg, days, maps, series, byDate};
}

/* ---------- generic UI pieces ---------- */
function table(id, cols, rows, def = {}) {
  const s = SORT[id] ??= {k: def.k ?? cols[0].k, dir: def.dir ?? -1};
  const col = cols.find(c => c.k === s.k) || cols[0];
  const val = r => col.v ? col.v(r) : r[col.k];
  const sorted = [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    return s.dir * (typeof x === "string" ? x.localeCompare(y) : (x ?? -1e9) - (y ?? -1e9));
  });
  const head = cols.map(c => `<th data-sort="${id}" data-k="${c.k}" class="${c.l ? "l" : ""}${c.k === s.k ? " on" : ""}">${c.h}${c.k === s.k ? (s.dir < 0 ? " ▾" : " ▴") : ""}</th>`).join("");
  const body = sorted.map(r => `<tr${def.rowClass && def.rowClass(r) ? ` class="${def.rowClass(r)}"` : ""}>${cols.map(c => `<td${c.l ? ' class="l"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("");
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
const box = (title, body, right = "") => `<section class="box"><div class="box-head">${title}<span class="sp">${right}</span></div>${body}</section>`;
const dlBtn = (what, label = "↓ CSV") => `<button class="btn" data-dl="${esc(what)}">${label}</button>`;

function bars(items, {fmt = v => f(v), max} = {}) {
  const m = max ?? Math.max(...items.map(i => i.value), 0.0001);
  return `<div class="bars">${items.map(i => `<div class="row"><span>${i.label}</span><div class="bar"><i style="width:${Math.max(0, i.value) / m * 100}%;background:${i.color || ""}"></i></div><b>${fmt(i.value)}</b></div>`).join("")}</div>`;
}

function lineChart(xs, series, {base} = {}) {
  const W = 640, H = 200, L = 36, B = 22, T = 10, Rr = 10;
  const ys = series.flatMap(s => s.pts).filter(Number.isFinite);
  if (!ys.length) return "<p class='muted'>Not enough data.</p>";
  let lo = Math.min(...ys, base ?? Infinity), hi = Math.max(...ys, base ?? -Infinity);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * .08; lo -= pad; hi += pad;
  const x = i => xs.length < 2 ? (L + W - Rr) / 2 : L + i * (W - L - Rr) / (xs.length - 1);
  const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const lines = series.map((s, si) => {
    const c = COLORS[si % 8]; let seg = [], out = "";
    const flush = () => { if (seg.length > 1) out += `<polyline points="${seg.join(" ")}" fill="none" stroke="${c}" stroke-width="2"/>`; seg = []; };
    s.pts.forEach((v, i) => { if (Number.isFinite(v)) seg.push(`${x(i)},${y(v)}`); else flush(); });
    flush();
    return out + s.pts.map((v, i) => Number.isFinite(v) ? `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${c}"><title>${esc(s.name)} · ${esc(xs[i])}: ${f(v)}</title></circle>` : "").join("");
  }).join("");
  const step = Math.max(1, Math.ceil(xs.length / 8));
  const labels = xs.map((l, i) => i % step === 0 || i === xs.length - 1 && xs.length > 1 && i % step > step / 2 ? `<text x="${x(i)}" y="${H - 6}" fill="#8393a8" font-size="10" text-anchor="${i === xs.length - 1 && xs.length > 1 ? "end" : "middle"}">${esc(l)}</text>` : "").join("");
  const baseLine = base != null ? `<line x1="${L}" x2="${W - Rr}" y1="${y(base)}" y2="${y(base)}" stroke="#3d4f66" stroke-dasharray="4"/>` : "";
  const ticks = [lo + pad, hi - pad].map(v => `<text x="${L - 4}" y="${y(v) + 3}" fill="#8393a8" font-size="10" text-anchor="end">${f(v, 1)}</text>`).join("");
  const legend = series.length > 1 ? `<div class="legend">${series.map((s, i) => `<span><i style="background:${COLORS[i % 8]}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${baseLine}${ticks}${lines}${labels}</svg>${legend}`;
}

function scatter(points, xl, yl) {
  const W = 640, H = 260, L = 40, B = 30, T = 10, Rr = 20;
  if (points.length < 2) return "<p class='muted'>Not enough data.</p>";
  const ext = k => { const v = points.map(p => p[k]); let lo = Math.min(...v), hi = Math.max(...v); const pd = (hi - lo || 1) * .1; return [lo - pd, hi + pd]; };
  const [x0, x1] = ext("x"), [y0, y1] = ext("y");
  const px = v => L + (v - x0) / (x1 - x0) * (W - L - Rr), py = v => T + (y1 - v) / (y1 - y0) * (H - T - B);
  const dots = points.map(p => `<circle cx="${px(p.x)}" cy="${py(p.y)}" r="4" fill="var(--blue)"><title>${esc(p.name)}: ${f(p.x, 1)} / ${f(p.y)}</title></circle><text x="${px(p.x) + 7}" y="${py(p.y) + 3}" fill="#c8d1dc" font-size="10">${esc(p.name)}</text>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}"><line x1="${L}" x2="${W - Rr}" y1="${H - B}" y2="${H - B}" stroke="#3d4f66"/><line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="#3d4f66"/>${dots}<text x="${(W + L) / 2}" y="${H - 6}" fill="#8393a8" font-size="11" text-anchor="middle">${xl}</text><text x="12" y="${H / 2}" fill="#8393a8" font-size="11" transform="rotate(-90 12 ${H / 2})" text-anchor="middle">${yl}</text></svg>`;
}

function radar(axes) {
  const cx = 150, cy = 130, r = 95, n = axes.length;
  const pt = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * r * v / 100, cy + Math.sin(a) * r * v / 100]; };
  const ring = v => axes.map((_, i) => pt(i, v).join(",")).join(" ");
  const shape = axes.map((a, i) => pt(i, a.v).join(",")).join(" ");
  const labels = axes.map((a, i) => { const [x, y] = pt(i, 122); return `<text x="${x}" y="${y}" fill="#8393a8" font-size="10" text-anchor="middle">${a.h} ${Math.round(a.v)}</text>`; }).join("");
  return `<svg class="chart" viewBox="0 0 300 260" style="max-width:340px;margin:auto">${[25, 50, 75, 100].map(v => `<polygon points="${ring(v)}" fill="none" stroke="#2f3d50"/>`).join("")}${axes.map((_, i) => `<line x1="${cx}" y1="${cy}" x2="${pt(i, 100)[0]}" y2="${pt(i, 100)[1]}" stroke="#2f3d50"/>`).join("")}<polygon points="${shape}" fill="rgba(74,144,217,.35)" stroke="var(--blue)" stroke-width="2"/>${labels}</svg>`;
}

const pctOf = (name, fn) => {
  const vals = Object.values(DB.pagg).map(fn), me = fn(DB.pagg[name]);
  return (vals.filter(v => v < me).length + vals.filter(v => v === me).length / 2) / vals.length * 100;
};

/* ---------- filtering ---------- */
const filtered = () => DB.rows.filter(r => (!FILT.day || r.date === FILT.day) && (!FILT.map || r.map === FILT.map));
const filterBar = () => `<div class="box-body pivot-ctl">
  <label class="f">Scrim day <select data-act="filt" data-f="day"><option value="">All</option>${DB.days.map(d => `<option value="${d}"${FILT.day === d ? " selected" : ""}>${fdate(d)}</option>`).join("")}</select></label>
  <label class="f">Map <select data-act="filt" data-f="map"><option value="">All</option>${DB.maps.map(m => `<option${FILT.map === m ? " selected" : ""}>${m}</option>`).join("")}</select></label>
  <label class="f">Min maps <select data-act="filt" data-f="min">${[1, 2, 3, 5, 8].map(n => `<option${FILT.min === n ? " selected" : ""}>${n}</option>`).join("")}</select></label></div>`;

/* ---------- views ---------- */
function sourceNotice() {
  const full = DB.games.filter(g => g.ref?.win).length, scoreOnly = DB.games.filter(g => g.ref && !g.ref.win).length;
  return SRC === "refrag"
    ? `<div class="notice">Showing <b>official Refrag data</b>: ${full} match${full === 1 ? "" : "es"} with full scoreboards (real Refrag Rating &amp; KAST)${scoreOnly ? `, plus ${scoreOnly} score-only demo${scoreOnly === 1 ? "" : "s"}` : ""}. Switch to <b>Google Sheet</b> for the full history.</div>`
    : `<div class="notice">Showing the <b>Google Sheet</b> history (${DB.games.length} maps). Rating* is estimated from kills, deaths, assists and ADR; ${full} match${full === 1 ? " has" : "es have"} an official Refrag scoreboard on the <a href="#days">Scrim Days</a> page.</div>`;
}

function leaderRows(rows) {
  const g = {};
  rows.forEach(r => (g[r.name] ??= []).push(r));
  return Object.entries(g).map(([name, rs]) => {
    // A/B only mean something within one scrim day, so a team is attached only to single-day groups.
    const one = new Set(rs.map(r => r.date)).size === 1, ts = new Set(rs.map(r => r.team).filter(Boolean));
    return {name, ...agg(rs), date: one ? rs[0].date : null, team: one && ts.size === 1 ? [...ts][0] : null};
  }).filter(p => p.n >= FILT.min);
}
const teamCol = () => ({k: "team", h: "Team", l: 1, v: r => r.team ? teamName(r.date, r.team) : "", f: r => r.team ? teamPill(r.date, r.team) : ""});
const teamRow = r => r.team ? "t" + r.team : "";
const teamDot = (name, date) => {
  const r = date && DB.rows.find(x => x.name === name && x.date === date && x.team);
  return r ? `<i class="dot t${r.team}" title="${esc(teamName(date, r.team))}"></i>` : "";
};

function overview() {
  const rows = filtered(), L = leaderRows(rows);
  const days = new Set(rows.map(r => r.date)), games = new Set(rows.map(r => r.g));
  const cols = [
    {k: "name", h: "Player", l: 1, f: r => pl(r.name)},
    {k: "n", h: "Maps", f: r => r.n},
    {k: "diff", h: "K-D", v: r => r.k - r.d, f: r => sgn(r.k - r.d)},
    {k: "kd", h: "K/D", f: r => f(r.kd)},
    {k: "adr", h: "ADR", f: r => f(r.adr, 1)},
    {k: "hs", h: "HS%", f: r => f(r.hs, 0) + "%"},
    {k: "winPct", h: "Win%", f: r => r.winPct == null ? "–" : f(r.winPct, 0) + "%"},
    {k: "rating", h: RL(), f: r => rt(r.rating)},
  ];
  if (FILT.day) cols.splice(1, 0, teamCol());
  const top = [...L].sort((a, b) => b.rating - a.rating).slice(0, 10);
  const lastDay = DB.days[0], ser = DB.series[lastDay];
  const dayRows = DB.rows.filter(r => r.date === lastDay), mvp = leaderRows(dayRows).sort((a, b) => b.rating - a.rating)[0];
  $("#app").innerHTML = sourceNotice() +
    box("Filters", filterBar(), dlBtn("all", "↓ All data (CSV)")) +
    `<div class="cards" style="margin-bottom:14px">
      <div class="card"><b>${L.length}</b><span>Players</span></div>
      <div class="card"><b>${games.size}</b><span>Maps</span></div>
      <div class="card"><b>${days.size}</b><span>Scrim days</span></div>
      <div class="card"><b>${rows.reduce((t, r) => t + r.k, 0)}</b><span>Kills</span></div>
      <div class="card"><b>${f(mean(rows.map(r => r.adr)), 1)}</b><span>Avg ADR</span></div></div>` +
    (lastDay && !FILT.day ? box(`Latest scrim day · ${fdate(lastDay)}`, `<div class="box-body">${ser ? `${esc(teamName(lastDay, "A"))} <b>${ser.wins.A}</b> – <b>${ser.wins.B}</b> ${esc(teamName(lastDay, "B"))} · ` : ""}${DB.byDate[lastDay].length} maps · MVP ${mvp ? `${mvp.team ? teamPill(lastDay, mvp.team) + " " : ""}${pl(mvp.name)} (${rt(mvp.rating)})` : "–"}</div>`, `<a class="btn" href="#days/${lastDay}">Open</a>`) : "") +
    `<div class="grid g2">` +
    box("Top players", `<div class="box-body">${bars(top.map(p => ({label: pl(p.name), value: p.rating})), {max: Math.max(1.6, ...top.map(p => p.rating))})}</div>`) +
    box("ADR vs K/D", `<div class="box-body">${scatter(L.map(p => ({name: p.name, x: p.adr, y: p.kd})), "ADR", "K/D")}</div>`) + `</div>` +
    box("Leaderboard", table("lead", cols, L, {k: "rating", rowClass: teamRow}), `<span class="tip">click a header to sort${FILT.day ? "" : " · teams show when you pick a scrim day in Filters (A/B only mean something within one day)"}</span>`);
}

function teamName(date, side) {
  const s = DB.series[date];
  if (!s) return side === "A" ? "Team 1" : "Team 2";
  const rs = DB.rows.filter(r => r.date === date && s[side].includes(r.name));
  const best = leaderRows(rs).sort((a, b) => b.rating - a.rating)[0];
  return best ? `team_${best.name.toLowerCase()}` : (side === "A" ? "Team 1" : "Team 2");
}

// Team A / B are fixed per scrim day (the first scoreboard of the day sets the rosters), so a player keeps one colour all day.
const teamOf = (date, name) => { const s = DB.series[date]; return s ? (s.A.includes(name) ? "A" : s.B.includes(name) ? "B" : null) : null; };
const teamPill = (date, side) => `<span class="pill t${side}">${esc(teamName(date, side))}</span>`;

function scoreboard(m, g) {
  const t = (title, cls, ps) => `<div class="teamhead ${cls}">${title}</div><div class="scroll"><table><thead><tr><th>Player</th><th>Rating</th><th>K / D / A</th><th>+/-</th><th>ADR</th><th>HS%</th><th>KAST</th><th class="l">Roles</th></tr></thead><tbody>${[...ps].sort((a, b) => b.rating - a.rating).map(p => {
    const a = REF.aliases[p.name], tm = g && teamOf(g.date, a || p.name);
    return `<tr${tm ? ` class="t${tm}"` : ""}><td>${a ? pl(a) + `<small>${esc(p.name)}</small>` : esc(p.name)}</td><td>${p.rating == null ? "–" : rt(p.rating)}</td><td>${p.k} / ${p.d} / ${p.a}</td><td>${sgn(p.k - p.d)}</td><td>${f(p.adr, 1)}</td><td>${f(p.hs, 0)}%</td><td>${p.kast == null ? "–" : f(p.kast * 100, 0) + "%"}</td><td class="l muted">${esc((p.roles || []).join(", "))}</td></tr>`;
  }).join("")}</tbody></table></div>`;
  const side = s => g && g.winner ? teamPill(g.date, s === "win" ? g.winner : g.winner === "A" ? "B" : "A") + " " : "";
  return t(`${side("win")}Winners · ${m.score[0]}`, "w", m.win) + t(`${side("lose")}Losers · ${m.score[1]}`, "x", m.lose);
}

function gameHtml(g, open = false) {
  const m = g.ref;
  const badge = m?.win ? `<span class="badge ref">Refrag</span>` : m ? `<span class="badge">score only</span>` : `<span class="badge">sheet</span>`;
  const loc = m?.local ? `<span class="badge loc">local</span>` : "";
  let body;
  if (m?.win) body = scoreboard(m, g);
  else if (g.rows.length) {
    const cols = [
      {k: "name", h: "Player", l: 1, f: r => pl(r.name)},
      {k: "k", h: "K / D / A", f: r => `${r.k} / ${r.d} / ${r.a}`, v: r => r.k},
      {k: "diff", h: "+/-", v: r => r.k - r.d, f: r => sgn(r.k - r.d)},
      {k: "adr", h: "ADR", f: r => f(r.adr, 1)}, {k: "hs", h: "HS%", f: r => f(r.hs, 0) + "%"},
      {k: "r", h: "Rating*", v: rowRating, f: r => rt(rowRating(r))}];
    body = table("g" + g.i, cols, g.rows, {k: "r", rowClass: r => r.team ? "t" + r.team : ""});
  } else body = `<div class="box-body muted">Score only: Refrag has no scoreboard for this demo ("Stats not available").</div>`;
  const acts = `<div class="actions">${g.rows.length ? dlBtn(`g:${g.i}:csv`) : ""}${m?.win ? dlBtn(`g:${g.i}:json`, "↓ JSON (re-importable)") : ""}${SB && signedIn() && m && !m.local ? `<button class="btn danger" data-act="rmremote" data-id="${esc(m.id)}">Remove from site</button>` : ""}${m?.local ? `<button class="btn danger" data-act="rmlocal" data-id="${esc(m.id)}">Remove local</button>` : ""}</div>`;
  return `<details class="game" id="g${g.i}"${open ? " open" : ""}><summary><b>${esc(g.map)}</b>${badge}${loc}<span class="muted">${m?.time ? esc(m.time) : ""}</span><span class="sc">${g.score ? g.score.join(" – ") : ""}</span></summary><div class="gbody">${body}${acts}</div></details>`;
}

function daysView(focus) {
  const html = DB.days.map(d => {
    const gs = DB.byDate[d], ser = DB.series[d], rows = DB.rows.filter(r => r.date === d);
    const L = leaderRows(rows).sort((a, b) => b.rating - a.rating);
    const header = ser ? `<div class="series"><div class="team"><b class="tcA">${esc(teamName(d, "A"))}</b><small>${ser.A.map(esc).join(", ")}</small></div>
        <div class="big"><span class="${ser.wins.A >= ser.wins.B ? "w" : "x"}">${ser.wins.A}</span> : <span class="${ser.wins.B > ser.wins.A ? "w" : "x"}">${ser.wins.B}</span><div class="muted" style="font-size:11px;font-weight:400">best of 3 · ${ser.games} played</div></div>
        <div class="team"><b class="tcB">${esc(teamName(d, "B"))}</b><small>${ser.B.map(esc).join(", ")}</small></div></div>` : "";
    const maps = `<div class="maps">${gs.map(g => `<a class="mapcard" href="#days/${d}/g${g.i}"><b>${esc(g.map)}</b><span class="sc">${g.score ? g.score.join(" – ") : "–"}</span></a>`).join("")}</div>`;
    const mvp = L[0];
    return `<div id="day-${d}">` + box(`${fdate(d)} · ${gs.length} map${gs.length === 1 ? "" : "s"}`,
      header + maps + (mvp ? `<div class="box-body" style="padding-top:0">MVP: ${mvp.team ? teamPill(d, mvp.team) + " " : ""}${pl(mvp.name)} ${rt(mvp.rating)} · ${mvp.k}-${mvp.d} · ${f(mvp.adr, 1)} ADR</div>` : "") +
      `<div class="box-head" style="border-top:1px solid var(--line)">Maps</div>${gs.map(g => gameHtml(g, focus === "g" + g.i)).join("")}` +
      (L.length ? `<details class="game"><summary><b>Day leaderboard</b></summary><div class="gbody">${table("day" + d, dayCols(L.some(p => p.team)), L, {k: "rating", rowClass: teamRow})}</div></details>` : ""),
      `${dlBtn("d:" + d + ":csv")} ${dlBtn("d:" + d + ":json", "↓ JSON")}`) + `</div>`;
  }).join("");
  $("#app").innerHTML = `<h1>Scrim days</h1>${sourceNotice()}<div class="box"><div class="box-body">Jump to: ${DB.days.map(d => `<a class="btn" href="#days/${d}">${fdate(d)}</a>`).join(" ")}</div></div>${html}`;
}
const dayCols = withTeam => [
  {k: "name", h: "Player", l: 1, f: r => pl(r.name)}, ...(withTeam ? [teamCol()] : []), {k: "n", h: "Maps", f: r => r.n},
  {k: "kd", h: "K/D", f: r => f(r.kd)}, {k: "adr", h: "ADR", f: r => f(r.adr, 1)}, {k: "hs", h: "HS%", f: r => f(r.hs, 0) + "%"},
  {k: "rating", h: RL(), f: r => rt(r.rating)}];

function playersView() {
  const q = (store.get("q", "") || "").toLowerCase();
  const L = leaderRows(DB.rows).sort((a, b) => b.rating - a.rating).filter(p => p.name.toLowerCase().includes(q));
  $("#app").innerHTML = `<h1>Players</h1><div class="box"><div class="box-body"><input type="search" id="q" placeholder="Search players…" value="${esc(q)}" data-act="search"></div></div>
    <div class="pgrid">${L.map(p => `<a class="pcard" href="#p/${encodeURIComponent(p.name)}"><b>${esc(p.name)}</b><span class="rt ${rc(p.rating)}">${f(p.rating)}</span><br><span class="muted">${p.n} maps · ${f(p.kd)} K/D · ${f(p.adr, 0)} ADR</span></a>`).join("")}</div>`;
}

function playerView(name) {
  const rows = DB.players[name];
  if (!rows) { $("#app").innerHTML = `<div class="notice err">No data for ${esc(name)} in this source.</div>`; return; }
  const a = DB.pagg[name], sorted = [...rows].sort((x, y) => x.date.localeCompare(y.date) || x.g - y.g);
  const rank = Object.values(DB.pagg).filter(p => p.rating > a.rating).length + 1, total = Object.keys(DB.pagg).length;
  const axes = [
    {h: "Rating", v: pctOf(name, p => p.rating)}, {h: "ADR", v: pctOf(name, p => p.adr)}, {h: "K/D", v: pctOf(name, p => p.kd)},
    {h: "HS%", v: pctOf(name, p => p.hs)}, {h: "Assists", v: pctOf(name, p => p.apr)}, {h: "Survival", v: pctOf(name, p => -p.dpr)}];
  const xs = sorted.map((r, i) => `${r.date.slice(5)} ${r.map}`);
  const trend = lineChart(xs, [{name: RL(), pts: sorted.map(rowRating)}, {name: "K/D", pts: sorted.map(r => r.k / (r.d || 1))}], {base: 1});
  const byDay = {}, byMap = {}, roles = {};
  sorted.forEach(r => { (byDay[r.date] ??= []).push(r); (byMap[r.map] ??= []).push(r); (r.roles || []).forEach(x => roles[x] = (roles[x] || 0) + 1); });
  const grp = (o, key) => Object.entries(o).map(([k, rs]) => {
    const ts = new Set(rs.map(r => r.team).filter(Boolean));
    return {[key]: k, ...agg(rs), team: key === "date" && ts.size === 1 ? [...ts][0] : null};
  });
  const gcols = (key, h, link) => [{k: key, h, l: 1, f: r => link ? `<a class="pl" href="#days/${r[key]}">${fdate(r[key])}</a>` : esc(r[key])}, ...(key === "date" ? [teamCol()] : []),
    {k: "n", h: "Maps", f: r => r.n}, {k: "kd", h: "K/D", f: r => f(r.kd)}, {k: "adr", h: "ADR", f: r => f(r.adr, 1)}, {k: "hs", h: "HS%", f: r => f(r.hs, 0) + "%"},
    {k: "winPct", h: "Win%", f: r => r.winPct == null ? "–" : f(r.winPct, 0) + "%"}, {k: "rating", h: RL(), f: r => rt(r.rating)}];
  const log = sorted.slice().reverse().map(r => `<tr><td><a class="pl" href="#days/${r.date}/g${r.g}">${fdate(r.date)}</a></td><td class="l">${esc(r.map)}</td><td class="l">${r.team ? teamPill(r.date, r.team) : ""}</td><td>${r.win == null ? "–" : r.win ? '<span class="pos">W</span>' : '<span class="neg">L</span>'}</td><td>${r.k} / ${r.d} / ${r.a}</td><td>${f(r.k / (r.d || 1))}</td><td>${f(r.adr, 1)}</td><td>${f(r.hs, 0)}%</td><td>${rt(rowRating(r))}</td></tr>`).join("");
  const best = sorted.reduce((x, y) => rowRating(y) > rowRating(x) ? y : x), worst = sorted.reduce((x, y) => rowRating(y) < rowRating(x) ? y : x);
  $("#app").innerHTML = `<p><a class="btn" href="#players">← Players</a></p>` +
    box("Player", `<div class="hero"><h1>${esc(name)}</h1><span class="rt ${rc(a.rating)}">${f(a.rating)}</span><span class="muted">${RL()} · #${rank} of ${total}</span>${Object.keys(roles).length ? `<span class="muted">Roles: ${Object.entries(roles).sort((x, y) => y[1] - x[1]).map(([r]) => esc(r)).join(", ")}</span>` : ""}</div>
      <div class="box-body"><div class="cards">${[["K/D", f(a.kd)], ["ADR", f(a.adr, 1)], ["HS%", f(a.hs, 0) + "%"], ["Maps", a.n], ["Kills", a.k], ["Deaths", a.d], ["KPR", f(a.kpr)], ["Win%", a.winPct == null ? "–" : f(a.winPct, 0) + "%"], ["Consistency", f(a.sd)], ["Best", f(a.best)], ["Worst", f(a.worst)]].map(([l, v]) => `<div class="card"><b>${v}</b><span>${l}</span></div>`).join("")}</div></div>`, dlBtn("p:" + name + ":csv")) +
    `<div class="grid g2">` + box("Percentile vs the group", `<div class="box-body">${radar(axes)}</div>`) +
    box(`${RL()} and K/D per map`, `<div class="box-body">${trend}</div>`) + `</div>` +
    `<div class="notice">Best map: <b>${fdate(best.date)} ${esc(best.map)}</b> (${f(rowRating(best))}, ${best.k}-${best.d}) · Worst: <b>${fdate(worst.date)} ${esc(worst.map)}</b> (${f(rowRating(worst))}, ${worst.k}-${worst.d}) · Consistency is the standard deviation of per-map rating (lower is steadier).</div>` +
    box("By scrim day", table("pd" + name, gcols("date", "Day", true), grp(byDay, "date"), {k: "date", dir: -1, rowClass: teamRow})) +
    box("By map", table("pm" + name, gcols("map", "Map"), grp(byMap, "map"), {k: "rating"})) +
    box("Match log", `<div class="scroll"><table><thead><tr><th>Date</th><th class="l">Map</th><th class="l">Team</th><th>Result</th><th>K / D / A</th><th>K/D</th><th>ADR</th><th>HS%</th><th>${RL()}</th></tr></thead><tbody>${log}</tbody></table></div>`);
}

function heatStyle(v, lo, hi) {
  if (!Number.isFinite(v)) return "";
  const t = (v - lo) / ((hi - lo) || 1);
  return `background:color-mix(in srgb, var(--blue) ${Math.round(t * 55)}%, transparent)`;
}

function mapsView() {
  const rows = DB.rows;
  const mcols = [
    {k: "map", h: "Map", l: 1, f: r => esc(r.map)}, {k: "games", h: "Played", f: r => r.games},
    {k: "rounds", h: "Avg rounds", f: r => f(r.avgRounds, 1)}, {k: "margin", h: "Avg margin", f: r => r.margin == null ? "–" : f(r.margin, 1)},
    {k: "adr", h: "Avg ADR", f: r => f(r.adr, 1)}, {k: "top", h: "Top player", l: 1, v: r => r.topRating, f: r => r.top ? `${pl(r.top)} ${rt(r.topRating)}` : "–"}];
  const mrows = DB.maps.map(m => {
    const gs = DB.games.filter(g => g.map === m), rs = rows.filter(r => r.map === m), L = leaderRows(rs).sort((a, b) => b.rating - a.rating);
    const scored = gs.filter(g => g.score);
    return {map: m, games: gs.length, avgRounds: mean(gs.map(g => g.score ? g.score[0] + g.score[1] : g.rows[0]?.rounds).filter(Number.isFinite)),
      margin: scored.length ? mean(scored.map(g => Math.abs(g.score[0] - g.score[1]))) : null, adr: mean(rs.map(r => r.adr)), top: L[0]?.name, topRating: L[0]?.rating};
  });
  const names = Object.keys(DB.players).sort((a, b) => DB.pagg[b].rating - DB.pagg[a].rating);
  const cellv = {}; let lo = Infinity, hi = -Infinity;
  names.forEach(n => DB.maps.forEach(m => { const rs = DB.players[n].filter(r => r.map === m); if (rs.length) { const v = agg(rs).rating; cellv[n + "|" + m] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
  const heat = `<div class="scroll"><table><thead><tr><th>Player</th>${DB.maps.map(m => `<th>${esc(m)}</th>`).join("")}</tr></thead><tbody>${names.map(n => `<tr><td>${pl(n)}</td>${DB.maps.map(m => { const v = cellv[n + "|" + m]; return `<td class="heat" style="${heatStyle(v, lo, hi)}">${v == null ? "" : f(v)}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div>`;
  $("#app").innerHTML = `<h1>Maps</h1>${sourceNotice()}` + box("Map overview", table("maps", mcols, mrows, {k: "games"})) + box(`${RL()} by player and map`, heat, `<span class="tip">brighter = higher</span>`);
}

function recordsView() {
  const rows = DB.rows;
  const top = (title, filterFn, val, fmt, n = 5, asc = false) => {
    const rs = rows.filter(filterFn).sort((a, b) => asc ? val(a) - val(b) : val(b) - val(a)).slice(0, n);
    return box(title, `<div class="scroll"><table><tbody>${rs.map((r, i) => `<tr><td>${i + 1}. ${r.team ? `<i class="dot t${r.team}" title="${esc(teamName(r.date, r.team))}"></i>` : ""}${pl(r.name)}</td><td class="muted"><a class="pl" href="#days/${r.date}/g${r.g}">${fdate(r.date)} · ${esc(r.map)}</a></td><td><b>${fmt(r)}</b></td></tr>`).join("")}</tbody></table></div>`);
  };
  const scored = DB.games.filter(g => g.score);
  const gl = (title, fn) => box(title, `<div class="scroll"><table><tbody>${[...scored].sort(fn).slice(0, 5).map(g => `<tr><td><a class="pl" href="#days/${g.date}/g${g.i}">${fdate(g.date)} · ${esc(g.map)}</a></td><td><b>${g.score.join(" – ")}</b></td></tr>`).join("")}</tbody></table></div>`);
  // improvement: second half of a player's maps vs the first half
  const imp = Object.entries(DB.players).filter(([, rs]) => rs.length >= 4).map(([name, rs]) => {
    const s = [...rs].sort((a, b) => a.date.localeCompare(b.date) || a.g - b.g), h = Math.floor(s.length / 2);
    return {name, delta: agg(s.slice(h)).rating - agg(s.slice(0, h)).rating};
  }).sort((a, b) => b.delta - a.delta);
  const impBox = box("Most improved / declined (first vs second half)", imp.length ? `<div class="scroll"><table><tbody>${[...imp.slice(0, 3), ...imp.slice(-3).filter(x => !imp.slice(0, 3).includes(x))].map(x => `<tr><td>${pl(x.name)}</td><td><b class="${x.delta >= 0 ? "pos" : "neg"}">${x.delta >= 0 ? "+" : ""}${f(x.delta)}</b></td></tr>`).join("")}</tbody></table></div>` : `<div class="box-body muted">Needs 4+ maps per player.</div>`);
  // MVPs
  const mvps = {};
  DB.days.forEach(d => { const m = leaderRows(rows.filter(r => r.date === d)).sort((a, b) => b.rating - a.rating)[0]; if (m) mvps[m.name] = (mvps[m.name] || 0) + 1; });
  const mvpBox = box("Scrim day MVPs", `<div class="scroll"><table><tbody>${Object.entries(mvps).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `<tr><td>${pl(n)}</td><td><b>${c}</b></td></tr>`).join("")}</tbody></table></div>`);
  // duos
  const pairs = {};
  DB.games.forEach(g => {
    const byTeam = {};
    g.rows.forEach(r => { if (r.team) (byTeam[r.team] ??= []).push(r); });
    Object.values(byTeam).forEach(t => t.forEach((x, i) => t.slice(i + 1).forEach(y => {
      const key = [x.name, y.name].sort().join(" + "); const p = pairs[key] ??= {key, g: 0, w: 0};
      p.g++; if (x.win) p.w++;
    })));
  });
  const duoRows = Object.values(pairs).filter(p => p.g >= 2).sort((a, b) => b.w / b.g - a.w / a.g || b.g - a.g).slice(0, 8);
  const duoBox = box("Duos (same team, 2+ maps)", duoRows.length ? `<div class="scroll"><table><tbody>${duoRows.map(p => `<tr><td>${esc(p.key)}</td><td class="muted">${p.g} maps</td><td><b>${f(p.w / p.g * 100, 0)}%</b> win</td></tr>`).join("")}</tbody></table></div>` : `<div class="box-body muted">Needs matches with known teams.</div>`);
  $("#app").innerHTML = `<h1>Records</h1>${sourceNotice()}<div class="grid g2">` +
    top("Most kills in a map", () => true, r => r.k, r => r.k) +
    top("Highest ADR", () => true, r => r.adr, r => f(r.adr, 1)) +
    top("Best K/D", r => r.k >= 5, r => r.k / (r.d || 1), r => f(r.k / (r.d || 1))) +
    top("Best map rating", () => true, rowRating, r => f(rowRating(r))) +
    top("Highest HS% (8+ kills)", r => r.k >= 8, r => r.hs, r => f(r.hs, 0) + "%") +
    top("Most assists", () => true, r => r.a, r => r.a) +
    top("Most deaths", () => true, r => r.d, r => r.d) +
    top("Worst map rating", () => true, rowRating, r => f(rowRating(r)), 5, true) +
    gl("Closest games", (a, b) => Math.abs(a.score[0] - a.score[1]) - Math.abs(b.score[0] - b.score[1])) +
    gl("Biggest blowouts", (a, b) => Math.abs(b.score[0] - b.score[1]) - Math.abs(a.score[0] - a.score[1])) +
    impBox + mvpBox + duoBox + `</div>`;
}

function compareView(a, b) {
  const names = Object.keys(DB.players).sort();
  const sel = (id, v) => `<select data-act="cmp" id="${id}">${names.map(n => `<option${n === v ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`;
  a = DB.players[a] ? a : names[0]; b = DB.players[b] ? b : names[1] || names[0];
  const A = DB.pagg[a], B = DB.pagg[b];
  const line = (h, k, d, lowerBetter) => {
    const x = A[k], y = B[k], win = x === y ? 0 : (x > y) !== !!lowerBetter ? 1 : 2;
    return `<tr><td class="${win === 1 ? "pos" : ""}"><b>${f(x, d)}</b></td><td class="muted">${h}</td><td class="${win === 2 ? "pos" : ""}"><b>${f(y, d)}</b></td></tr>`;
  };
  const dates = [...new Set([...DB.players[a], ...DB.players[b]].map(r => r.date))].sort();
  const ser = n => ({name: n, pts: dates.map(d => { const rs = DB.players[n].filter(r => r.date === d); return rs.length ? agg(rs).rating : NaN; })});
  const shared = DB.games.filter(g => g.rows.some(r => r.name === a) && g.rows.some(r => r.name === b));
  let mates = 0, opp = 0, wMates = 0, aAhead = 0;
  shared.forEach(g => {
    const x = g.rows.find(r => r.name === a), y = g.rows.find(r => r.name === b);
    if (x.team && x.team === y.team) { mates++; if (x.win) wMates++; } else if (x.team && y.team) { opp++; if (rowRating(x) > rowRating(y)) aAhead++; }
  });
  $("#app").innerHTML = `<h1>Compare</h1>` + box("Pick two players", `<div class="box-body pivot-ctl">${sel("ca", a)} <b>vs</b> ${sel("cb", b)}</div>`) +
    `<div class="grid g2">` + box("Head to head", `<div class="scroll"><table><tbody>
      <tr><th style="text-align:left">${pl(a)}</th><th style="text-align:center"></th><th>${pl(b)}</th></tr>
      ${line(RL(), "rating", 2)}${line("K/D", "kd", 2)}${line("ADR", "adr", 1)}${line("HS%", "hs", 1)}${line("KPR", "kpr", 2)}${line("Deaths / round", "dpr", 2, true)}${line("Assists / round", "apr", 2)}${line("Maps", "n", 0)}${line("Consistency (lower is steadier)", "sd", 2, true)}</tbody></table></div>`) +
    box("Rating by scrim day", `<div class="box-body">${lineChart(dates.map(d => d.slice(5)), [ser(a), ser(b)], {base: 1})}</div>`) + `</div>` +
    box("Shared maps", `<div class="box-body">${shared.length} maps together. ${mates ? `As teammates: ${mates} maps, ${f(wMates / mates * 100, 0)}% wins. ` : ""}${opp ? `As opponents: ${esc(a)} out-rated ${esc(b)} in ${aAhead} of ${opp}. ` : ""}${!mates && !opp ? "Teams are only known for games with a Refrag scoreboard." : ""}</div>` +
      (shared.length ? `<div class="scroll"><table><thead><tr><th>Date</th><th class="l">Map</th><th class="l">${esc(a)}</th><th class="l">${esc(b)}</th><th class="l">Relation</th></tr></thead><tbody>${shared.map(g => {
        const x = g.rows.find(r => r.name === a), y = g.rows.find(r => r.name === b);
        const pill = r => r.team ? teamPill(g.date, r.team) : "<span class='muted'>unknown</span>";
        return `<tr><td>${fdate(g.date)}</td><td class="l">${esc(g.map)}</td><td class="l">${pill(x)}</td><td class="l">${pill(y)}</td><td class="l">${!x.team || !y.team ? "–" : x.team === y.team ? "teammates" : "opponents"}</td></tr>`;
      }).join("")}</tbody></table></div>` : ""));
}

/* ---------- pivot ---------- */
const DIM = {
  player: {h: "Player", f: r => r.name}, map: {h: "Map", f: r => r.map}, date: {h: "Scrim day", f: r => r.date},
  month: {h: "Month", f: r => r.date.slice(0, 7)}, result: {h: "Result", f: r => r.win == null ? "Unknown" : r.win ? "Win" : "Loss"},
  role: {h: "Role", f: r => r.roles?.[0] || "Unknown"}, team: {h: "Team (per scrim day)", f: r => r.team ? teamName(r.date, r.team) : "Unknown"},
};
const MEAS = {
  rating: {h: "Rating", f: g => g.rating, d: 2}, kd: {h: "K/D", f: g => g.kd, d: 2}, adr: {h: "ADR", f: g => g.adr, d: 1},
  hs: {h: "HS %", f: g => g.hs, d: 1}, kpr: {h: "Kills / round", f: g => g.kpr, d: 2}, dpr: {h: "Deaths / round", f: g => g.dpr, d: 2},
  kills: {h: "Kills (total)", f: g => g.k, d: 0}, killsAvg: {h: "Kills / map", f: g => g.k / g.n, d: 1},
  deaths: {h: "Deaths (total)", f: g => g.d, d: 0}, deathsAvg: {h: "Deaths / map", f: g => g.d / g.n, d: 1},
  assists: {h: "Assists (total)", f: g => g.a, d: 0}, diff: {h: "Kills − deaths", f: g => g.k - g.d, d: 0},
  maps: {h: "Maps (count)", f: g => g.n, d: 0}, winPct: {h: "Win %", f: g => g.winPct, d: 0},
  best: {h: "Best map rating", f: g => g.best, d: 2}, worst: {h: "Worst map rating", f: g => g.worst, d: 2}, sd: {h: "Rating std-dev", f: g => g.sd, d: 2},
};
function pivotParams() {
  const q = new URLSearchParams((location.hash.split("?")[1]) || "");
  return {rows: DIM[q.get("rows")] ? q.get("rows") : "player", cols: DIM[q.get("cols")] ? q.get("cols") : "", val: MEAS[q.get("val")] ? q.get("val") : "rating",
    chart: q.get("chart") || "bars", day: q.get("day") || "", map: q.get("map") || "", min: +q.get("min") || 1};
}
function pivotCompute(P) {
  const rows = DB.rows.filter(r => (!P.day || r.date === P.day) && (!P.map || r.map === P.map));
  const rk = DIM[P.rows].f, ck = P.cols ? DIM[P.cols].f : null, M = MEAS[P.val];
  const grid = {}, all = {};
  rows.forEach(r => { const a = rk(r), b = ck ? ck(r) : "All"; ((grid[a] ??= {})[b] ??= []).push(r); (all[a] ??= []).push(r); });
  let rkeys = Object.keys(grid).filter(a => all[a].length >= P.min);
  const ckeys = ck ? [...new Set(rows.map(ck))].sort() : ["All"];
  const total = Object.fromEntries(rkeys.map(a => [a, M.f(agg(all[a]))]));
  const chrono = P.rows === "date" || P.rows === "month";
  rkeys.sort(chrono ? (x, y) => x.localeCompare(y) : (x, y) => (total[y] ?? -1e9) - (total[x] ?? -1e9));
  const cells = Object.fromEntries(rkeys.map(a => [a, ckeys.map(b => grid[a][b] ? M.f(agg(grid[a][b])) : null)]));
  return {rkeys, ckeys, cells, total, M, rows};
}
function pivotView() {
  const P = pivotParams(), C = pivotCompute(P), M = C.M;
  const opt = (obj, cur, blank) => (blank ? `<option value="">${blank}</option>` : "") + Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === cur ? " selected" : ""}>${v.h}</option>`).join("");
  const flat = C.rkeys.flatMap(a => C.cells[a]).filter(Number.isFinite);
  const lo = Math.min(...flat), hi = Math.max(...flat);
  const fmt = v => v == null || !Number.isFinite(v) ? "" : f(v, M.d);
  const label = k => P.rows === "player" ? teamDot(k, P.day) + pl(k) : (P.rows === "date" ? `<a class="pl" href="#days/${k}">${fdate(k)}</a>` : esc(k));
  const tbl = `<div class="scroll"><table><thead><tr><th>${DIM[P.rows].h}${P.cols ? ` \\ ${DIM[P.cols].h}` : ""}</th>${P.cols ? C.ckeys.map(c => `<th>${esc(P.cols === "date" ? c.slice(5) : c)}</th>`).join("") : ""}<th>${P.cols ? "All" : M.h}</th></tr></thead><tbody>${C.rkeys.map(a =>
    `<tr><td>${label(a)}</td>${P.cols ? C.cells[a].map(v => `<td class="heat" style="${heatStyle(v, lo, hi)}">${fmt(v)}</td>`).join("") : ""}<td class="heat" style="${P.cols ? "" : heatStyle(C.total[a], lo, hi)}"><b>${fmt(C.total[a])}</b></td></tr>`).join("")}</tbody></table></div>`;
  let chart = "";
  if (P.chart === "bars" && C.rkeys.length) {
    const items = C.rkeys.slice(0, 25).map(a => ({label: P.rows === "player" ? teamDot(a, P.day) + pl(a) : esc(P.rows === "date" ? fdate(a) : a), value: C.total[a] ?? 0}));
    chart = bars(items, {fmt});
  } else if (P.chart === "lines") {
    if (P.cols) chart = lineChart(C.ckeys.map(c => P.cols === "date" ? c.slice(5) : c), C.rkeys.slice(0, 8).map(a => ({name: a, pts: C.cells[a].map(v => v ?? NaN)})));
    else chart = lineChart(C.rkeys.map(a => P.rows === "date" ? a.slice(5) : a), [{name: M.h, pts: C.rkeys.map(a => C.total[a] ?? NaN)}]);
    if (P.cols && C.rkeys.length > 8) chart += `<p class="tip">Showing the top 8 rows.</p>`;
  }
  $("#app").innerHTML = `<h1>Pivot</h1>` + box("Build a pivot", `<div class="box-body pivot-ctl">
      <label class="f">Rows <select data-act="pv" id="pv-rows">${opt(DIM, P.rows)}</select></label>
      <label class="f">Columns <select data-act="pv" id="pv-cols">${opt(DIM, P.cols, "(none)")}</select></label>
      <label class="f">Value <select data-act="pv" id="pv-val">${opt(MEAS, P.val)}</select></label>
      <label class="f">Chart <select data-act="pv" id="pv-chart">${[["bars", "Bars"], ["lines", "Lines"], ["none", "Table only"]].map(([k, v]) => `<option value="${k}"${P.chart === k ? " selected" : ""}>${v}</option>`).join("")}</select></label>
      <label class="f">Scrim day <select data-act="pv" id="pv-day"><option value="">All</option>${DB.days.map(d => `<option value="${d}"${P.day === d ? " selected" : ""}>${fdate(d)}</option>`).join("")}</select></label>
      <label class="f">Map <select data-act="pv" id="pv-map"><option value="">All</option>${DB.maps.map(m => `<option${P.map === m ? " selected" : ""}>${m}</option>`).join("")}</select></label>
      <label class="f">Min maps <select data-act="pv" id="pv-min">${[1, 2, 3, 5, 8].map(n => `<option${P.min === n ? " selected" : ""}>${n}</option>`).join("")}</select></label>
    </div><div class="box-body tip" style="padding-top:0">K/D, ADR, HS% and ratings are recalculated over each group (total kills ÷ total deaths, damage ÷ rounds), not averaged per map. The URL holds your setup, so you can bookmark or share it.</div>`, dlBtn("pivot", "↓ Pivot CSV")) +
    (C.rkeys.length ? (P.chart !== "none" ? box(`${M.h} by ${DIM[P.rows].h.toLowerCase()}${P.cols ? " and " + DIM[P.cols].h.toLowerCase() : ""}`, `<div class="box-body">${chart}</div>`) : "") + box("Pivot table", tbl) : `<div class="notice">No data matches those filters.</div>`);
}

/* ---------- contribute ---------- */
const SNIPPET_URL = "tools/export-refrag-match.js";
const REPO = "umatt1/10mans";
let SNIPPET = "";
function contributeView() {
  const loc = LOCAL.length ? box("Matches added in this browser", `<div class="scroll"><table><tbody>${LOCAL.map(m => `<tr><td>${fdate(m.date)} · ${esc(m.map)}</td><td>${m.score.join(" – ")}</td><td>${m.win ? "scoreboard" : "score only"}</td><td><button class="btn danger" data-act="rmlocal" data-id="${esc(m.id)}">Remove</button></td></tr>`).join("")}</tbody></table></div>`,
    `<button class="btn" data-act="dlLocal">↓ Download all as one file</button>`) : "";
  $("#app").innerHTML = `<h1>Contribute a match</h1>
    <div class="notice">Played a 10 man that isn't on the site? If you can open it on <b>play.refrag.gg</b> (your own Refrag account, even a free one, if you were in the match), you can add it in about a minute.</div>
    ${box("1 · Export from Refrag", `<div class="box-body"><ol class="steps">
      <li>Log into <a href="https://play.refrag.gg/matches" target="_blank" rel="noopener">play.refrag.gg/matches</a>. Scrims and uploaded demos are on the <b>Uploaded &amp; Scrims</b> tab. Open the match and click <b>Match Page</b> so you see the full scoreboard.</li>
      <li>Easiest: drag this button to your bookmarks bar, then click it on the match page: <a class="btn pri" id="bm" href="#">⭳ Export Refrag match</a></li>
      <li>No bookmarks bar? Open DevTools (F12) → Console, paste the script below, press Enter:<pre id="snip">loading…</pre><button class="btn" data-act="copySnip">Copy script</button></li>
      <li>A file like <code>2026-10-17-dust2-13-10.json</code> downloads. Matches with "Stats not available" have no scoreboard, so use the score-only template below.</li></ol></div>`)}
    ${box("2 · Drop it here to preview", `<div class="box-body"><div class="drop" id="drop">Drag &amp; drop match <code>.json</code> files here, or click to choose<input type="file" id="file" accept=".json,application/json" multiple hidden></div>
      <p class="tip">Or paste JSON: </p><textarea id="paste" placeholder='{"date":"2026-10-17","map":"Dust2","score":[13,10], ...}'></textarea>
      <div class="actions" style="padding-left:0"><button class="btn" data-act="parsePaste">Preview pasted JSON</button></div><div id="pend"></div></div>`)}
    ${loc}
    ${SB ? cloudBox() : box("3 · Make it permanent (for everyone)", `<div class="box-body"><ol class="steps">
      <li>Open <a href="https://github.com/${REPO}/upload/main/data/matches" target="_blank" rel="noopener">the repo's upload page</a> (needs a free GitHub account). Drag the downloaded file(s) in. If you aren't a collaborator GitHub will offer to fork and open a pull request, which is fine.</li>
      <li>Commit. A GitHub Action validates the files, rebuilds <code>data/matches.json</code> and the site updates in a minute or two. A bad file fails the check with a readable message.</li>
      <li>Player names that aren't in <a href="https://github.com/${REPO}/blob/main/data/aliases.json" target="_blank" rel="noopener"><code>data/aliases.json</code></a> show up under their Refrag in-game name. Add <code>"in-game name": "Sheet name"</code> there to merge them into the right player.</li>
      <li>Stats for the Google Sheet are still entered in the sheet as usual. They sync every 6 hours.</li></ol></div>`)}
    ${box("Match file format", `<div class="box-body"><p>Full scoreboard (what the export script produces, first five players are the winners):</p><pre>{
 "id": "refrag-match-uuid",      // optional, generated if missing
 "date": "2026-10-17", "time": "8:36 PM",  // time optional, orders maps within a day
 "map": "Dust2", "score": [13, 10], "source": "refrag",
 "win":  [ {"name":"OATH","roles":["AWPer"],"rating":1.23,"k":22,"d":16,"a":9,"hs":54.5,"kpr":0.96,"adr":101.13,"kast":0.74}, ... ],
 "lose": [ ... ]
}</pre><p>Score-only (when Refrag has no scoreboard): just <code>{"date":"2026-04-10","map":"Mirage","score":[13,3]}</code>. A file can also be an array of matches.</p>
      ${dlBtn("template", "↓ Download template")}</div>`)}`;
  if (!SNIPPET) fetch(SNIPPET_URL).then(r => r.text()).then(t => { SNIPPET = t; fillSnippet(); }).catch(() => {}); else fillSnippet();
  renderPend();
}
function cloudBox() {
  const body = signedIn()
    ? `<div class="box-body">Signed in as <b>${esc(SESSION.email)}</b>. Previewed matches above get a <b>Publish</b> button. The server re-checks the file and adds it for everyone.
        <div class="actions" style="padding-left:0"><button class="btn" data-act="logout">Sign out</button></div></div>`
    : `<div class="box-body"><p class="muted">Publishing needs the shared login you were given.</p>
        <div class="pivot-ctl"><input type="text" id="sb-user" placeholder="Username / email" autocomplete="username"><input type="password" id="sb-pass" placeholder="Password" autocomplete="current-password" style="background:#131a23;color:var(--text);border:1px solid var(--line);border-radius:3px;padding:5px 8px"><button class="btn pri" data-act="login">Sign in</button></div></div>`;
  return box("3 · Publish for everyone", body);
}
function fillSnippet() {
  const el = $("#snip"); if (!el) return;
  el.textContent = SNIPPET;
  $("#bm")?.setAttribute("href", "javascript:" + encodeURIComponent(SNIPPET.replace(/^\s*\/\/.*$/gm, "")));
}

function validateMatch(m) {
  const p = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m?.date || "")) p.push("date must be YYYY-MM-DD");
  if (!m?.map) p.push("map is missing");
  if (!(Array.isArray(m?.score) && m.score.length === 2 && m.score.every(Number.isInteger))) p.push("score must be [int, int]");
  if (!!m?.win !== !!m?.lose) p.push("win and lose must both be present");
  for (const side of ["win", "lose"]) for (const x of m?.[side] || [])
    if (!x.name || !["k", "d", "a"].every(k => Number.isFinite(x[k]))) p.push(`${side}: ${x.name || "a player"} needs name, k, d, a`);
  if (!p.length) m.id ||= `${m.date}-${String(m.map).toLowerCase()}-${m.score.join("-")}`;
  const dup = p.length ? null : [...REF.matches, ...LOCAL].find(x => x.id === m.id || (x.date === m.date && x.map.toLowerCase() === String(m.map).toLowerCase() && x.score.join() === m.score.join()));
  if (dup) p.push("already on the site");
  return p;
}
function takeText(text, name) {
  let data;
  try { data = JSON.parse(text); } catch (e) { PEND.push({name, problems: ["not valid JSON: " + e.message]}); return; }
  for (const m of (Array.isArray(data) ? data : data.matches || [data])) PEND.push({name, m, problems: validateMatch(m)});
}
function renderPend() {
  const el = $("#pend"); if (!el) return;
  if (!PEND.length) { el.innerHTML = ""; return; }
  const good = PEND.filter(x => !x.problems.length);
  el.innerHTML = `<div class="scroll"><table><thead><tr><th>File</th><th>Match</th><th>Players</th><th>Status</th></tr></thead><tbody>${PEND.map(x => {
    const unk = x.m?.win ? [...x.m.win, ...x.m.lose].map(p => p.name).filter(n => !REF.aliases[n]) : [];
    return `<tr><td class="l">${esc(x.name)}</td><td class="l">${x.m ? esc(x.m.date) + " · " + esc(x.m.map) + " · " + esc((x.m.score || []).join("–")) : ""}</td><td>${x.m?.win ? x.m.win.length + x.m.lose.length : "–"}</td><td class="l ${x.problems.length ? "neg" : "pos"}">${x.problems.length ? esc(x.problems.join("; ")) : x.sending ? "Publishing…" : "OK"}${unk.length ? `<br><small>unmapped names: ${esc(unk.join(", "))}</small>` : ""}</td></tr>`;
  }).join("")}</tbody></table></div>
  <div class="actions" style="padding-left:0">${good.length ? `${SB && signedIn() ? `<button class="btn pri" data-act="publish"${BUSY ? " disabled" : ""}>${BUSY ? "Publishing…" : `Publish ${good.length} for everyone`}</button>` : ""}<button class="btn${SB && signedIn() ? "" : " pri"}" data-act="addLocal">Add ${good.length} to this browser</button><button class="btn" data-act="dlPend">↓ Download ${good.length} for upload</button>` : ""}<button class="btn" data-act="clearPend">Clear</button></div>
  <p class="tip">"Add to this browser" is a private preview stored locally. Use the upload step below to publish for everyone.</p>`;
}
async function takeFiles(files) {
  for (const file of files) takeText(await file.text(), file.name);
  renderPend();
}

/* ---------- data layer (static JSON or Supabase) ---------- */
const getJson = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); });
const rest = p => fetch(CFG.supabaseUrl + "/rest/v1/" + p, {headers: {apikey: CFG.supabaseAnonKey, Authorization: "Bearer " + CFG.supabaseAnonKey}})
  .then(r => { if (!r.ok) throw new Error(p + " " + r.status); return r.json(); });
async function loadData() {
  const stats = await getJson("data/stats.json");
  if (!SB) return [stats, await getJson("data/matches.json")];
  const [ms, al] = await Promise.all([rest("matches?select=data&order=date.desc"), rest("aliases?select=ingame,player")]);
  return [stats, {aliases: Object.fromEntries(al.map(x => [x.ingame, x.player])), matches: ms.map(m => m.data)}];
}
async function sbLogin(email, password) {
  const r = await fetch(CFG.supabaseUrl + "/auth/v1/token?grant_type=password", {method: "POST", headers: {apikey: CFG.supabaseAnonKey, "Content-Type": "application/json"}, body: JSON.stringify({email, password})});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.msg || "login failed");
  SESSION = {token: j.access_token, email: j.user?.email || email, exp: Date.now() + j.expires_in * 1000};
  store.set("sb", SESSION);
}
const signedIn = () => !!(SESSION && SESSION.exp > Date.now());
async function sbCall(body) {
  if (!signedIn()) { SESSION = null; store.set("sb", null); throw new Error("Your session expired. Sign in again on the Contribute page."); }
  const r = await fetch(CFG.supabaseUrl + "/functions/v1/ingest-match", {method: "POST", headers: {apikey: CFG.supabaseAnonKey, Authorization: "Bearer " + SESSION.token, "Content-Type": "application/json"}, body: JSON.stringify(body)});
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { SESSION = null; store.set("sb", null); }
  if (!r.ok) { const e = new Error(j.error || "request failed (" + r.status + ")"); e.results = j.results; throw e; }
  return j;
}
const reloadData = async () => { [SHEET, REF] = await loadData(); buildDB(); };
let toastTimer;
const flash = (msg, bad) => {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.className = "toast " + (bad ? "err" : "ok"); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 9000 : 5000);
};
// Two-step confirm for destructive buttons: first click arms, second click (within 4s) runs.
function armed(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = "1"; btn.dataset.label = btn.textContent; btn.textContent = "Click again to confirm";
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 4000);
  return false;
}


/* ---------- history (the ledger) ---------- */
async function historyView() {
  if (!SB) { $("#app").innerHTML = `<div class="notice">History needs the Supabase version of the site.</div>`; return; }
  $("#app").innerHTML = `<h1>History</h1><p class="muted">Loading…</p>`;
  let ev, head, audit;
  try {
    [ev, head, audit] = await Promise.all([
      rest("match_events?select=seq,at,action,match_id,by_email,note,superseded,data&order=seq.desc"),
      rest("ledger_head?select=seq"), rest("ledger_audit?select=at,by_email,action,from_seq,to_seq&order=at.desc&limit=15")]);
  } catch (e) { $("#app").innerHTML = `<div class="notice err">Couldn't load history: ${esc(e.message)}</div>`; return; }
  const h = head[0]?.seq ?? 0, live = ev.filter(e => !e.superseded).sort((x, y) => x.seq - y.seq);
  const prev = [...live].reverse().find(e => e.seq < h), next = live.find(e => e.seq > h), can = signedIn();
  const state = e => e.superseded ? "discarded" : e.seq === h ? "current" : e.seq < h ? "applied" : "undone";
  const btn = (seq, text) => can ? `<button class="btn" data-act="ledger" data-seq="${seq}">${text}</button>` : "";
  const when = t => new Date(t).toLocaleString();
  const rows = ev.map(e => {
    const s = state(e), what = e.action === "add" ? "Added" : "Removed";
    const act = s === "applied" ? btn(e.seq, "Roll back to here") : s === "undone" ? btn(e.seq, "Fast-forward to here") : "";
    return `<tr class="${s}"><td>${e.seq}</td><td class="l">${when(e.at)}</td><td class="l"><span class="badge${e.action === "add" ? " ref" : ""}">${what}</span> ${fdate(e.data.date)} · ${esc(e.data.map)} ${(e.data.score || []).join("–")}${e.note ? ` <small>${esc(e.note)}</small>` : ""}</td><td class="l muted">${esc(e.by_email || "")}</td><td class="l">${s === "current" ? "<b>◀ current</b>" : s === "undone" ? "rolled back" : s === "discarded" ? "discarded" : ""}</td><td>${act}</td></tr>`;
  }).join("");
  const start = h > 0 ? btn(0, "Roll back to the very start (empty)") : "";
  $("#app").innerHTML = `<h1>History</h1>
    <div class="notice">Every change is an entry in this list; nothing is deleted. The site shows the state at the <b>current</b> entry (#${h}). Roll back to undo later entries, fast-forward to redo them. Making a new change while rolled back discards the entries you rolled back past.</div>` +
    box("Controls", `<div class="box-body pivot-ctl">${can ? `${prev ? btn(prev.seq, "◀ Step back") : h > 0 ? btn(0, "◀ Step back") : ""}${next ? btn(next.seq, "Step forward ▶") : ""}${start}` : `<span class="muted">Read-only. <a href="#contribute">Sign in</a> to roll back or fast-forward.</span>`}</div>`) +
    box("Changes (newest first)", `<div class="scroll"><table><thead><tr><th>#</th><th class="l">When</th><th class="l">Change</th><th class="l">By</th><th class="l">State</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`) +
    (audit.length ? box("Rollbacks and fast-forwards", `<div class="scroll"><table><tbody>${audit.map(a => `<tr><td class="l">${when(a.at)}</td><td class="l">${esc(a.action)}</td><td>#${a.from_seq} → #${a.to_seq}</td><td class="l muted">${esc(a.by_email || "")}</td></tr>`).join("")}</tbody></table></div>`) : "");
}

/* ---------- downloads ---------- */
function handleDownload(what) {
  const [kind, id, fmt] = what.split(":");
  if (what === "all") return download(`10mans-${SRC}-all.csv`, toCsv(ROW_HEAD, DB.rows.map(rowCsv)), "text/csv");
  if (what === "pivot") return download("10mans-pivot.csv", pivotCsv(), "text/csv");
  if (what === "template") return download("match-template.json", JSON.stringify({date: "2026-10-17", time: "8:36 PM", map: "Dust2", score: [13, 10], source: "refrag",
    win: [{name: "Player", roles: ["Entry"], rating: 1.2, k: 20, d: 15, a: 5, hs: 50, kpr: 0.9, adr: 85, kast: 0.75}], lose: []}, null, 1), "application/json");
  if (kind === "g") {
    const g = DB.games[+id];
    if (fmt === "json") return download(`${g.date}-${g.map.toLowerCase()}-${g.score.join("-")}.json`, JSON.stringify(g.ref, null, 1), "application/json");
    return download(`${g.date}-${g.map.toLowerCase()}.csv`, toCsv(ROW_HEAD, g.rows.map(rowCsv)), "text/csv");
  }
  if (kind === "d") {
    const gs = DB.byDate[id];
    if (fmt === "json") return download(`10mans-${id}.json`, JSON.stringify(gs.map(g => g.ref || {date: g.date, map: g.map, players: g.rows}), null, 1), "application/json");
    return download(`10mans-${id}.csv`, toCsv(ROW_HEAD, gs.flatMap(g => g.rows).map(rowCsv)), "text/csv");
  }
  if (kind === "p") return download(`${id}.csv`, toCsv(ROW_HEAD, DB.players[id].map(rowCsv)), "text/csv");
}
function pivotCsv() {
  const P = pivotParams(), C = pivotCompute(P);
  return toCsv([DIM[P.rows].h, ...(P.cols ? C.ckeys : []), P.cols ? "All" : C.M.h], C.rkeys.map(a => [a, ...(P.cols ? C.cells[a].map(v => v == null ? "" : f(v, C.M.d)) : []), f(C.total[a], C.M.d)]));
}

/* ---------- events & router ---------- */
document.addEventListener("click", e => {
  const th = e.target.closest("th[data-sort]");
  if (th) { const s = SORT[th.dataset.sort]; s.dir = s.k === th.dataset.k ? -s.dir : (th.dataset.k === "name" || th.dataset.k === "map" ? 1 : -1); s.k = th.dataset.k; return route(true); }
  const b = e.target.closest("[data-src]");
  if (b) { SRC = b.dataset.src; store.set("src", SRC); buildDB(); return route(true); }
  const d = e.target.closest("[data-dl]");
  if (d) return handleDownload(d.dataset.dl);
  const a = e.target.closest("[data-act]");
  if (!a) { if (e.target.closest("#drop")) $("#file").click(); return; }
  const act = a.dataset.act;
  if (act === "copySnip") navigator.clipboard?.writeText(SNIPPET);
  if (act === "parsePaste") { const t = $("#paste").value.trim(); if (t) { takeText(t, "pasted"); renderPend(); } }
  if (act === "clearPend") { PEND = []; renderPend(); }
  if (act === "addLocal") {
    PEND.filter(x => !x.problems.length).forEach(x => LOCAL.push(x.m)); PEND = PEND.filter(x => x.problems.length);
    store.set("local", LOCAL); buildDB(); route(true);
  }
  if (act === "dlPend") { const ms = PEND.filter(x => !x.problems.length).map(x => x.m); download(ms.length === 1 ? `${ms[0].date}-${ms[0].map.toLowerCase()}-${ms[0].score.join("-")}.json` : `matches-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(ms.length === 1 ? ms[0] : ms, null, 1), "application/json"); }
  if (act === "login") sbLogin($("#sb-user").value.trim(), $("#sb-pass").value).then(() => contributeView(), err => flash(err.message, true));
  if (act === "logout") { SESSION = null; store.set("sb", null); contributeView(); }
  if (act === "publish") {
    const ok = PEND.filter(x => !x.problems.length);
    if (BUSY || !ok.length) return;
    BUSY = true; ok.forEach(x => { x.sending = true; }); renderPend();
    const settle = results => (results || []).forEach((r, i) => { if (ok[i] && !r.ok) ok[i].problems = r.problems || ["rejected"]; });
    sbCall({action: "add", matches: ok.map(x => x.m)}).then(async res => {
      settle(res.results);
      PEND = PEND.filter(x => x.problems.length);
      await reloadData(); BUSY = false; contributeView();
      flash(`Published ${res.inserted} match${res.inserted === 1 ? "" : "es"}${PEND.length ? `; ${PEND.length} rejected, see the preview table` : ""}.`, !!PEND.length);
    }).catch(err => {
      settle(err.results); ok.forEach(x => { x.sending = false; });
      BUSY = false; renderPend(); flash(err.message, true);
    });
  }
  if (act === "rmremote") {
    if (BUSY || !armed(a)) return;
    BUSY = true; a.disabled = true;
    sbCall({action: "remove", id: a.dataset.id}).then(async () => { await reloadData(); BUSY = false; route(true); flash("Removed from the site. Undo it from the History page."); },
      err => { BUSY = false; a.disabled = false; flash(err.message, true); });
  }
  if (act === "ledger") {
    if (BUSY || !armed(a)) return;
    BUSY = true; a.disabled = true;
    sbCall({action: "move", seq: +a.dataset.seq}).then(async () => { await reloadData(); BUSY = false; await historyView(); flash("History moved. The site now shows that state."); },
      err => { BUSY = false; a.disabled = false; flash(err.message, true); });
  }
  if (act === "dlLocal") download("matches-local.json", JSON.stringify(LOCAL, null, 1), "application/json");
  if (act === "rmlocal") { LOCAL = LOCAL.filter(m => m.id !== a.dataset.id); store.set("local", LOCAL); buildDB(); route(true); }
});
document.addEventListener("change", e => {
  const t = e.target, act = t.dataset.act;
  if (t.id === "file") return takeFiles(t.files);
  if (act === "filt") { FILT[t.dataset.f] = t.dataset.f === "min" ? +t.value : t.value; route(true); }
  if (act === "cmp") location.hash = `compare/${encodeURIComponent($("#ca").value)}/${encodeURIComponent($("#cb").value)}`;
  if (act === "pv") {
    const q = new URLSearchParams();
    [["rows", "pv-rows"], ["cols", "pv-cols"], ["val", "pv-val"], ["chart", "pv-chart"], ["day", "pv-day"], ["map", "pv-map"], ["min", "pv-min"]].forEach(([k, id]) => { const v = $("#" + id).value; if (v) q.set(k, v); });
    history.replaceState(null, "", "#pivot?" + q); pivotView(); markNav();
  }
});
document.addEventListener("input", e => { if (e.target.dataset.act === "search") { store.set("q", e.target.value); const pos = e.target.selectionStart; playersView(); const el = $("#q"); el.focus(); el.setSelectionRange(pos, pos); } });
["dragover", "dragenter"].forEach(ev => document.addEventListener(ev, e => { if (e.target.closest?.("#drop")) { e.preventDefault(); $("#drop").classList.add("over"); } }));
["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => {
  if (!e.target.closest?.("#drop")) return;
  e.preventDefault(); $("#drop").classList.remove("over");
  if (ev === "drop") takeFiles(e.dataTransfer.files);
}));
// A file dropped outside the zone should not navigate away from the page.
["dragover", "drop"].forEach(ev => window.addEventListener(ev, e => { if (!e.target.closest?.("#drop")) e.preventDefault(); }));

const NAV = [["", "Overview"], ["days", "Scrim Days"], ["players", "Players"], ["maps", "Maps"], ["records", "Records"], ["compare", "Compare"], ["pivot", "Pivot"], ["contribute", "Contribute"]];
function markNav() {
  const h = location.hash.slice(1).split(/[/?]/)[0], cur = h === "p" ? "players" : h;
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("on", a.dataset.r === cur));
  document.querySelectorAll("#src button").forEach(b => b.classList.toggle("on", b.dataset.src === SRC));
}
function route(keepScroll) {
  const [path, ...rest] = location.hash.slice(1).split("?")[0].split("/");
  const seg = rest.map(decodeURIComponent);
  const y = scrollY;
  if (path === "days") { daysView(seg[1]); const t = seg[1] ? document.getElementById(seg[1]) : seg[0] ? document.getElementById("day-" + seg[0]) : null; if (t) { if (t.tagName === "DETAILS") t.open = true; t.scrollIntoView(); } else if (!keepScroll) scrollTo(0, 0); }
  else {
    ({"": overview, players: playersView, maps: mapsView, records: recordsView, pivot: pivotView, contribute: contributeView, history: historyView}[path] ||
      (path === "p" ? () => playerView(seg[0]) : path === "compare" ? () => compareView(seg[0], seg[1]) : overview))();
    keepScroll ? scrollTo(0, y) : scrollTo(0, 0);
  }
  markNav();
}

loadData()
  .then(([s, r]) => {
    SHEET = s; REF = r;
    $("#nav").innerHTML = (SB ? [...NAV, ["history", "History"]] : NAV).map(([h, l]) => `<a href="#${h}" data-r="${h}">${l}</a>`).join("");
    $("#foot").innerHTML = `Sheet synced ${new Date(s.updated).toLocaleString()} · ${r.matches.length} Refrag matches (${r.matches.filter(m => m.win).length} with scoreboards) · <a href="https://github.com/${REPO}">source</a><br>Rating* is an estimate (HLTV-2.0-style from kills, deaths, assists and ADR); Refrag Rating is Refrag's own number. Not affiliated with HLTV or Refrag.`;
    buildDB(); addEventListener("hashchange", () => route()); route();
  })
  .catch(e => $("#app").innerHTML = `<div class="notice err">Couldn't load data: ${esc(e.message)}</div>`);
