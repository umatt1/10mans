// "static": match data comes from data/*.json (GitHub Pages, no backend).
// "supabase": matches and name aliases come from Supabase, and signed-in users can upload (see docs/MIGRATION.md).
// The publishable key is meant to be public; row-level security (supabase/schema.sql) is what protects the data.
window.TENMANS = {
  mode: "supabase",
  supabaseUrl: "https://sipcpfxjjsxsdozdommz.supabase.co",
  supabaseAnonKey: "sb_publishable_DnCeIIxe4L-MpCagPsvpjg_yi5rgbxm",
};
