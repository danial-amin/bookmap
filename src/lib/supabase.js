import { createClient } from "@supabase/supabase-js";

let client = null;

/** Publishable key (new) or legacy anon key — same role in the browser client. */
export function getSupabasePublishableKey() {
  return (
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    import.meta.env.VITE_SUPABASE_ANON_KEY ||
    ""
  );
}

export function isSupabaseConfigured() {
  const url = import.meta.env.VITE_SUPABASE_URL || "";
  const key = getSupabasePublishableKey();
  return (
    url.length > 10 &&
    key.length > 10 &&
    !url.includes("your-project") &&
    !key.includes("your-publishable") &&
    !key.includes("your-anon")
  );
}

export function getSupabase() {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createClient(import.meta.env.VITE_SUPABASE_URL, getSupabasePublishableKey());
  }
  return client;
}
