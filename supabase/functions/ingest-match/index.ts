// Edge function: the only way to change match data. Needs a signed-in user.
//   {action:"add", matches:[...]}   validate + append to the ledger (a bare array is treated as add)
//        a match is a Refrag scoreboard / score-only game, or {kind:"stats", date, map, players:[...]} from a CSV/Excel upload
//   {action:"remove", id}           append a remove entry (nothing is deleted)
//   {action:"move", seq}            roll back / fast-forward the ledger head (0 = empty start)
// Every write is a Postgres function (supabase/migrations/001_ledger.sql) that locks the head row, so a
// double-clicked or concurrent request is applied one at a time and duplicates are refused.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

export function problems(m: any): string[] {
  const p: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m?.date ?? "")) p.push("date must be YYYY-MM-DD");
  if (!m?.map) p.push("map missing");
  if (m?.kind === "stats") {
    const ps = m.players;
    if (!Array.isArray(ps) || ps.length < 1 || ps.length > 60) { p.push("players must be a list of 1-60"); return p; }
    for (const x of ps) {
      if (typeof x?.name !== "string" || !x.name.trim() || x.name.length > 40) p.push("every player needs a name (max 40 characters)");
      else if (!["k", "d", "a", "dmg", "rounds"].every((k) => Number.isFinite(x[k]) && x[k] >= 0) || !(x.rounds > 0)) p.push(`${x.name}: kills, deaths, assists, damage and rounds must be numbers (rounds above 0)`);
    }
    return p;
  }
  if (!(Array.isArray(m?.score) && m.score.length === 2 && m.score.every(Number.isInteger))) p.push("score must be [int, int]");
  if (!!m?.win !== !!m?.lose) p.push("win and lose must both be present");
  for (const side of ["win", "lose"]) {
    for (const x of m?.[side] ?? []) {
      if (!x.name || !["k", "d", "a"].every((k) => Number.isFinite(x[k]))) p.push(`${side}: player needs name, k, d, a`);
    }
  }
  return p;
}

// Stats uploads get a content-derived id, so the same file uploaded twice is refused as a duplicate, and only known fields are stored.
export async function cleanStats(m: any) {
  const players = m.players.map((x: any) => {
    const o: any = { name: x.name.trim(), k: x.k, d: x.d, a: x.a, hs: Number.isFinite(x.hs) ? x.hs : 0, dmg: x.dmg, rounds: x.rounds };
    if (typeof x.team === "string" && x.team.trim()) o.team = x.team.trim().slice(0, 40);
    if (typeof x.win === "boolean") o.win = x.win;
    return o;
  });
  const canon = JSON.stringify(players.map((p: any) => [p.name, p.k, p.d, p.a, p.dmg, p.rounds]).sort());
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(canon));
  const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
  const slug = String(m.map).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { kind: "stats", id: `stats-${m.date}-${slug}-${hash}`, date: m.date, map: String(m.map).trim(), rounds: m.rounds ?? players[0].rounds, source: "upload", players };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await db.auth.getUser(jwt);
  if (!user) return reply({ error: "Sign in to upload" }, 401);
  const who = user.email ?? user.id;

  let body: any;
  try { body = await req.json(); } catch { return reply({ error: "Body is not valid JSON" }, 400); }
  const action = Array.isArray(body) ? "add" : body?.action ?? "add";

  if (action === "remove") {
    const { data, error } = await db.rpc("ledger_remove", { mid: String(body.id ?? ""), by_email: who, note: body.note ?? null });
    if (error) return reply({ error: error.message }, 500);
    return data?.ok ? reply(data) : reply({ error: data?.error ?? "failed" }, 404);
  }
  if (action === "move") {
    const seq = Number(body.seq);
    if (!Number.isInteger(seq) || seq < 0) return reply({ error: "seq must be a non-negative integer" }, 400);
    const { data, error } = await db.rpc("ledger_move", { target: seq, by_email: who });
    if (error) return reply({ error: error.message }, 500);
    return data?.ok ? reply(data) : reply({ error: data?.error ?? "failed" }, 400);
  }
  if (action !== "add") return reply({ error: `Unknown action ${action}` }, 400);

  const list: any[] = Array.isArray(body) ? body : body?.matches ?? [body];
  if (!list.length || list.length > 50) return reply({ error: "Send between 1 and 50 matches" }, 400);

  const results = [];
  let inserted = 0;
  for (const m of list) {
    const bad = problems(m);
    if (bad.length) { results.push({ map: m?.map, ok: false, problems: bad }); continue; }
    const clean = m.kind === "stats" ? await cleanStats(m) : m;
    const { data, error } = await db.rpc("ledger_add", { m: clean, by_email: who, note: body?.note ?? null });
    if (error) { results.push({ id: m.id, ok: false, problems: [error.message] }); continue; }
    if (data?.ok) { inserted++; results.push({ id: data.id, ok: true, seq: data.seq }); }
    else results.push({ id: m.id, ok: false, problems: [data?.error ?? "rejected"] });
  }
  if (!inserted) return reply({ error: results.flatMap((r) => r.problems ?? []).join("; ") || "nothing to insert", results }, 422);
  return reply({ inserted, results });
});
