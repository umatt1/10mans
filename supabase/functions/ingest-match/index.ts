// Edge function: a signed-in user posts one match or an array of matches (the JSON the export script produces).
// It validates each one with the same rules as scripts/build_matches.py and inserts the good ones.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function problems(m: any): string[] {
  const p: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m?.date ?? "")) p.push("date must be YYYY-MM-DD");
  if (!m?.map) p.push("map missing");
  if (!(Array.isArray(m?.score) && m.score.length === 2 && m.score.every(Number.isInteger))) p.push("score must be [int, int]");
  if (!!m?.win !== !!m?.lose) p.push("win and lose must both be present");
  for (const side of ["win", "lose"]) {
    for (const x of m?.[side] ?? []) {
      if (!x.name || !["k", "d", "a"].every((k) => Number.isFinite(x[k]))) p.push(`${side}: player needs name, k, d, a`);
    }
  }
  return p;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await db.auth.getUser(jwt);
  if (!user) return reply({ error: "Sign in to upload" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return reply({ error: "Body is not valid JSON" }, 400); }
  const list: any[] = Array.isArray(body) ? body : body?.matches ?? [body];
  if (!list.length || list.length > 50) return reply({ error: "Send between 1 and 50 matches" }, 400);

  const results = [];
  let inserted = 0;
  for (const m of list) {
    const bad = problems(m);
    if (bad.length) { results.push({ map: m?.map, ok: false, problems: bad }); continue; }
    m.id ||= `${m.date}-${String(m.map).toLowerCase()}-${m.score.join("-")}`;
    const { error } = await db.from("matches").insert({
      id: m.id, date: m.date, map: m.map, score: m.score, data: m, uploaded_by: user.id,
    });
    if (error) {
      results.push({ id: m.id, ok: false, problems: [error.code === "23505" ? "already on the site" : error.message] });
    } else { inserted++; results.push({ id: m.id, ok: true }); }
  }
  if (!inserted) return reply({ error: results.flatMap((r) => r.problems ?? []).join("; ") || "nothing to insert", results }, 422);
  return reply({ inserted, results });
});
