import { getSupabase, isSupabaseConfigured } from "./lib/supabase.js";

const msg = document.getElementById("auth-callback-msg");

async function main() {
  if (!isSupabaseConfigured()) {
    msg.textContent = "Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.";
    return;
  }

  const supabase = getSupabase();
  const params = new URLSearchParams(location.search);
  const code = params.get("code");

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      msg.textContent = error.message;
      return;
    }
  }

  const home = new URL("../", location.href).href;
  location.replace(home);
}

main().catch((err) => {
  msg.textContent = err?.message || "Sign-in failed.";
});
