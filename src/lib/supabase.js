import { createClient } from "@supabase/supabase-js";

let client = null;

export function isSupabaseConfigured() {
  const url = import.meta.env.VITE_SUPABASE_URL || "";
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
  return (
    url.length > 10 &&
    key.length > 10 &&
    !url.includes("your-project") &&
    !key.includes("your-anon")
  );
}

export function getSupabase() {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY
    );
  }
  return client;
}
