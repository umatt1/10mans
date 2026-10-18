const $ = s => document.querySelector(s);
let DATA, REF, sort = {key: "rating", dir: -1};

// Rating is an HLTV-2.0-style estimate; KAST and impact aren't tracked so they are approximated.
function agg(rows) {
  const n = rows.length, sum = k => rows.reduce((t, r) => t + r[k], 0);
  const rounds = sum("rounds") || 1, k = sum("k"), d = sum("d"), a = sum("a"), dmg = sum("dmg");
  const kpr = k / rounds, dpr = d / rounds, apr = a / rounds, adr = dmg / rounds;
  const impact = 2.13 * kpr + 0.42 * apr - 0.41;
  const rating = 0.0073 * 70 + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587;
  const hs = n ? rows.reduce((t, r) => t + r.hs * r.k, 0) / (k || 1) : 0;
  return {maps: n, k, d, a, kd: k / (d || 1), adr, hs, rating, kpr};
}
const f = (v, p = 2) => v.toFixed(p);
const cls = (v, base) => v >= base ? "good" : "bad";
const stats = () => Object.entries(DATA.players).filter(([, r]) => r.length).map(([name, rows]) => ({name, rows, ...agg(rows)}));

function table(cols, rows, onSort) {
  const head = cols.map(c => `<th data-k="${c.k}" class="${c.k === sort.key ? "s" : ""}${c.l ? " l" : ""}">${c.h}</th>`).join("");
  const body = rows.map(r => `<tr>${cols.map(c => `<td${c.l ? ' class="l"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("");
  return `<div class="panel"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
const pl = n => `<a class="p" href="#p/${n}">${n}</a>`;

function home() {
  const s = stats(), q = s.filter(p => p.maps >= 3);
  const best = (k, label, fmt) => { const p = [...q].sort((a, b) => b[k] - a[k])[0]; return p ? `<div class="card"><span>${label}</span><b>${pl(p.name)}</b><span>${fmt(p[k])}</span></div>` : ""; };
  const cols = [
    {k: "name", h: "Player", l: 1, f: r => pl(r.name)},
    {k: "maps", h: "Maps", f: r => r.maps},
    {k: "kd", h: "K/D", f: r => `<span class="${cls(r.kd, 1)}">${f(r.kd)}</span>`},
    {k: "adr", h: "ADR", f: r => f(r.adr, 1)},
    {k: "hs", h: "HS%", f: r => f(r.hs, 0) + "%"},
    {k: "k", h: "K", f: r => r.k}, {k: "d", h: "D", f: r => r.d},
    {k: "rating", h: "Rating*", f: r => `<span class="rating ${cls(r.rating, 1)}">${f(r.rating)}</span>`},
  ];
  const rows = [...s].sort((a, b) => sort.dir * (typeof a[sort.key] === "string" ? a[sort.key].localeCompare(b[sort.key]) : a[sort.key] - b[sort.key]));
  const maps = new Set(Object.values(DATA.players).flat().map(r => r.map + r.date)).size;
  $("#app").innerHTML = `
    <div class="cards"><div class="card"><b>${s.length}</b><span>players</span></div>
    <div class="card"><b>${maps}</b><span>map sets played</span></div>
    <div class="card"><b>${new Set(Object.values(DATA.players).flat().map(r => r.date)).size}</b><span>LAN days</span></div></div>
    <h2>Top performers (3+ maps)</h2>
    <div class="top">${best("rating", "Best rating", v => f(v))}${best("adr", "Highest ADR", v => f(v, 1))}${best("kd", "Best K/D", v => f(v))}${best("hs", "Most headshots", v => f(v, 0) + "%")}</div>
    <h2>Leaderboard</h2>${table(cols, rows)}
    <small>*Rating is an estimate: KAST and impact aren't tracked, so they're approximated.</small>`;
  document.querySelectorAll("th").forEach(th => th.onclick = () => {
    const k = th.dataset.k; sort = {key: k, dir: sort.key === k ? -sort.dir : (k === "name" ? 1 : -1)}; home();
  });
}

function spark(rows) {
  const v = rows.map(r => r.d ? r.k / r.d : r.k), w = 600, h = 120, max = Math.max(2, ...v);
  const x = i => v.length < 2 ? w / 2 : 10 + i * (w - 20) / (v.length - 1), y = val => h - 10 - val / max * (h - 20);
  const pts = v.map((val, i) => `${x(i)},${y(val)}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" x2="${w}" y1="${y(1)}" y2="${y(1)}" stroke="#263243" stroke-dasharray="4"/><polyline points="${pts}" fill="none" stroke="#f5a623" stroke-width="2"/>${v.map((val, i) => `<circle cx="${x(i)}" cy="${y(val)}" r="3" fill="#f5a623"/>`).join("")}</svg>`;
}

function player(name) {
  const rows = DATA.players[name];
  if (!rows) return home();
  const a = agg(rows);
  const byMap = {};
  rows.forEach(r => (byMap[r.map] ||= []).push(r));
  const mapRows = Object.entries(byMap).map(([m, rs]) => ({m, ...agg(rs)})).sort((x, y) => y.rating - x.rating);
  const log = [...rows].sort((x, y) => y.date.localeCompare(x.date)).map(r => {
    const ar = agg([r]);
    return `<tr><td>${r.date}</td><td class="l">${r.map}</td><td>${r.k}/${r.d}/${r.a}</td><td>${f(ar.kd)}</td><td>${f(ar.adr, 1)}</td><td>${r.hs}%</td><td class="rating ${cls(ar.rating, 1)}">${f(ar.rating)}</td></tr>`;
  }).join("");
  $("#app").innerHTML = `<h2><a class="p" href="#">← Leaderboard</a></h2>
    <h1 style="margin:0 0 12px">${name}</h1>
    <div class="cards">${[["Rating*", f(a.rating)], ["K/D", f(a.kd)], ["ADR", f(a.adr, 1)], ["HS%", f(a.hs, 0) + "%"], ["Maps", a.maps]].map(([l, v]) => `<div class="card"><b>${v}</b><span>${l}</span></div>`).join("")}</div>
    <h2>K/D per map (dashed = 1.0)</h2><div class="panel">${spark([...rows].sort((x, y) => x.date.localeCompare(y.date)))}</div>
    <h2>By map</h2>${table([
      {k: "m", h: "Map", l: 1, f: r => r.m}, {k: "maps", h: "Played", f: r => r.maps},
      {k: "kd", h: "K/D", f: r => f(r.kd)}, {k: "adr", h: "ADR", f: r => f(r.adr, 1)}, {k: "rating", h: "Rating*", f: r => f(r.rating)},
    ], mapRows)}
    <h2>Match log</h2><div class="panel"><table><thead><tr><th>Date</th><th class="l">Map</th><th>K/D/A</th><th>K/D</th><th>ADR</th><th>HS%</th><th>Rating*</th></tr></thead><tbody>${log}</tbody></table></div>`;
}

const day = d => Date.parse(d) / 864e5;
function matchList() {
  const g = {};
  for (const [name, rows] of Object.entries(DATA.players))
    rows.forEach(r => {
      const map = r.map === "Dust" ? "Dust2" : r.map;
      (g[r.date + "|" + map] ||= {date: r.date, map, rows: []}).rows.push({name, ...r});
    });
  // The 04-25 Ancient row logged as 04-26 is folded into its real day.
  const list = Object.values(g).filter(m => m.rows.length > 1 || m.date !== "2026-04-26");
  const used = new Set();
  list.forEach(m => {
    const i = REF.matches.findIndex((x, j) => !used.has(j) && x.map === m.map && Math.abs(day(x.date) - day(m.date)) <= 1);
    if (i >= 0) { used.add(i); m.ref = REF.matches[i]; }
  });
  REF.matches.forEach((x, j) => { if (!used.has(j)) list.push({date: x.date, map: x.map, rows: [], ref: x}); });
  return list.sort((a, b) => b.date.localeCompare(a.date) || a.map.localeCompare(b.map));
}

function matches() {
  const board = (title, ps) => `<h2>${title}</h2><div class="panel"><table><thead><tr><th>Player</th><th>Rating</th><th>K/D/A</th><th>ADR</th><th>HS%</th><th>KAST</th></tr></thead><tbody>${ps.map(p => {
    const sheet = REF.aliases[p.name];
    return `<tr><td>${sheet ? pl(sheet) + ` <small>${p.name}</small>` : p.name}</td><td class="rating ${cls(p.rating, 1)}">${f(p.rating)}</td><td>${p.k}/${p.d}/${p.a}</td><td>${f(p.adr, 1)}</td><td>${f(p.hs, 0)}%</td><td>${f(p.kast * 100, 0)}%</td></tr>`;
  }).join("")}</tbody></table></div>`;
  const cards = matchList().map(m => {
    const x = m.ref, score = x ? `${x.score[0]} - ${x.score[1]}` : "";
    const body = x && x.win ? board("Winning team", x.win) + board("Losing team", x.lose)
      : m.rows.length ? `<div class="panel"><table><thead><tr><th>Player</th><th>K/D/A</th><th>ADR</th><th>HS%</th></tr></thead><tbody>${[...m.rows].sort((a, b) => b.k - a.k).map(r =>
          `<tr><td>${pl(r.name)}</td><td>${r.k}/${r.d}/${r.a}</td><td>${f(r.dmg / r.rounds, 1)}</td><td>${f(r.hs, 0)}%</td></tr>`).join("")}</tbody></table></div>`
      : "<small>Score only, no player stats available.</small>";
    return `<details class="panel m"><summary><b>${m.map}</b><span>${m.date}</span><span class="score">${score}</span><small>${x && x.win ? "Refrag + sheet" : x && m.rows.length ? "sheet + Refrag score" : m.rows.length ? "sheet only" : "Refrag demo list"}</small></summary>${body}</details>`;
  }).join("");
  $("#app").innerHTML = `<h2>Matches</h2>${cards}`;
}

function route() {
  const h = location.hash.slice(1);
  document.querySelectorAll("nav a").forEach(a => a.classList.toggle("on", a.getAttribute("href") === "#" + (h.startsWith("p/") ? "" : h)));
  h.startsWith("p/") ? player(decodeURIComponent(h.slice(2))) : h === "matches" ? matches() : home();
  window.scrollTo(0, 0);
}

Promise.all([fetch("data/stats.json"), fetch("data/matches.json")].map(p => p.then(r => r.json()))).then(([d, r]) => {
  DATA = d; REF = r;
  $("#nav").innerHTML = '<a href="#">Leaderboard</a><a href="#matches">Matches</a>';
  $("#updated").textContent = "Updated " + new Date(d.updated).toLocaleString();
  addEventListener("hashchange", route); route();
}).catch(e => $("#app").textContent = "Couldn't load data: " + e);
