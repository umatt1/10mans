// "static": match data comes from data/*.json (GitHub Pages, no backend).
// "supabase": matches and name aliases come from Supabase, and signed-in users can upload (see docs/MIGRATION.md).
// The anon key is meant to be public; row-level security in supabase/schema.sql is what protects the data.
window.TENMANS = {
  mode: "static",
  supabaseUrl: "",
  supabaseAnonKey: "",
};
