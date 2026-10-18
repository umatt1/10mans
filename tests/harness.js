// Loads the real app.js into a Node vm with a minimal fake DOM, so its logic and every view can be tested
// without a browser. fetch() is stubbed to serve data/*.json (or Supabase-shaped responses).
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.join(__dirname, "..");
const readJson = f => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));

function makeEl() {
  return {innerHTML: "", innerText: "", textContent: "", value: "", hidden: false, className: "", dataset: {}, style: {},
    classList: {toggle() {}, add() {}, remove() {}}, setAttribute() {}, appendChild() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, setSelectionRange() {}};
}

async function load({mode = "static", src = "sheet", local = [], session = null, fetchImpl} = {}) {
  const els = {}, listeners = {}, posts = [];
  const $el = sel => (els[sel] ??= makeEl());
  const storage = {src: JSON.stringify(src), local: JSON.stringify(local), sb: JSON.stringify(session)};
  const document = {
    querySelector: $el, querySelectorAll: () => [], getElementById: () => null, createElement: makeEl, body: makeEl(),
    addEventListener: (t, fn) => (listeners[t] ??= []).push(fn),
  };
  const matches = readJson("data/matches.json"), stats = readJson("data/stats.json");
  const defaultFetch = async (url, opts = {}) => {
    const ok = body => ({ok: true, status: 200, json: async () => body});
    if (opts.method === "POST") { posts.push({url, body: JSON.parse(opts.body)}); await new Promise(r => setTimeout(r, 30)); return ok({inserted: 1, results: [{ok: true}]}); }
    if (url.endsWith("data/stats.json")) return ok(stats);
    if (url.endsWith("data/matches.json")) return ok(matches);
    if (url.includes("/rest/v1/matches")) return ok(matches.matches.map(m => ({data: m})));
    if (url.includes("/rest/v1/aliases")) return ok(Object.entries(matches.aliases).map(([ingame, player]) => ({ingame, player})));
    return {ok: false, status: 404, json: async () => ({})};
  };
  const ctx = vm.createContext({
    document, console, setTimeout, clearTimeout, URL, URLSearchParams, Blob, TextDecoder, atob, btoa,
    window: {addEventListener() {}, TENMANS: mode === "supabase" ? {mode, supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "sb_publishable_test"} : {mode: "static"}},
    localStorage: {getItem: k => storage[k] ?? null, setItem: (k, v) => { storage[k] = v; }},
    location: {hash: ""}, history: {replaceState() {}}, navigator: {}, scrollTo() {}, scrollY: 0, addEventListener() {},
    fetch: fetchImpl ? (u, o) => fetchImpl(u, o, defaultFetch) : defaultFetch,
  });
  vm.runInContext(fs.readFileSync(path.join(root, "app.js"), "utf8"), ctx, {filename: "app.js"});
  for (let i = 0; i < 100 && !vm.runInContext("typeof DB !== 'undefined' && !!DB", ctx); i++) await new Promise(r => setImmediate(r));
  // Objects built inside the vm have a different prototype, so return plain JSON copies for deepEqual.
  const run = code => { const v = vm.runInContext(code, ctx); return v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v; };
  const runAsync = async code => { const v = await vm.runInContext(code, ctx); return v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v; };
  // Simulates a click on an element carrying data-act / data-* attributes.
  // Pass the same element twice to model a real button that keeps its state (e.g. the armed confirm).
  const click = (dataset, el = {dataset, textContent: "Button", isConnected: true, disabled: false}) => {
    const target = {closest: sel => (sel === "[data-act]" ? el : null)};
    listeners.click.forEach(fn => fn({target}));
    return el;
  };
  return {ctx, run, runAsync, el: $el, posts, click, matches, stats};
}
module.exports = {load, root, readJson};
