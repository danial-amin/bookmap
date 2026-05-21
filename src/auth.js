import { getSupabase, isSupabaseConfigured } from "./lib/supabase.js";

const authEls = {
  modal: null,
  form: null,
  email: null,
  password: null,
  message: null,
  modeBtn: null,
  submit: null,
  userLabel: null,
  signInBtn: null,
  signOutBtn: null,
};

let mode = "signin";
let currentUser = null;
const listeners = new Set();

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(currentUser);
}

export function getUser() {
  return currentUser;
}

export function bindAuthElements(ids) {
  authEls.modal = document.getElementById(ids.modal);
  authEls.form = document.getElementById(ids.form);
  authEls.email = document.getElementById(ids.email);
  authEls.password = document.getElementById(ids.password);
  authEls.message = document.getElementById(ids.message);
  authEls.modeBtn = document.getElementById(ids.modeBtn);
  authEls.submit = document.getElementById(ids.submit);
  authEls.userLabel = document.getElementById(ids.userLabel);
  authEls.signInBtn = document.getElementById(ids.signInBtn);
  authEls.signOutBtn = document.getElementById(ids.signOutBtn);
}

export function openAuthModal() {
  authEls.modal?.classList.remove("hidden");
  authEls.message.textContent = "";
}

export function closeAuthModal() {
  authEls.modal?.classList.add("hidden");
}

function setAuthMessage(msg) {
  if (authEls.message) authEls.message.textContent = msg || "";
}

function updateAuthChrome() {
  const signedIn = !!currentUser;
  authEls.signInBtn?.classList.toggle("hidden", signedIn);
  authEls.signOutBtn?.classList.toggle("hidden", !signedIn);
  if (authEls.userLabel) {
    authEls.userLabel.textContent = signedIn
      ? currentUser.email?.split("@")[0] || "Signed in"
      : "";
    authEls.userLabel.classList.toggle("hidden", !signedIn);
  }
  document.body.classList.toggle("signed-in", signedIn);
}

export async function initAuth() {
  if (!isSupabaseConfigured()) {
    setAuthMessage("Add Supabase keys to enable login (.env.example).");
    updateAuthChrome();
    return;
  }

  const supabase = getSupabase();

  if (location.pathname.endsWith("callback.html") || location.search.includes("code=")) {
    await handleAuthCallback(supabase);
  }

  const { data } = await supabase.auth.getSession();
  currentUser = data.session?.user ?? null;
  updateAuthChrome();
  notify();

  supabase.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user ?? null;
    updateAuthChrome();
    notify();
  });

  authEls.signInBtn?.addEventListener("click", () => openAuthModal());
  authEls.signOutBtn?.addEventListener("click", () => signOut());
  authEls.modal?.querySelector("[data-auth-close]")?.addEventListener("click", closeAuthModal);
  authEls.modal?.querySelector(".auth-backdrop")?.addEventListener("click", closeAuthModal);

  authEls.modeBtn?.addEventListener("click", () => {
    mode = mode === "signin" ? "signup" : "signin";
    authEls.modeBtn.textContent =
      mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in";
    authEls.submit.textContent = mode === "signin" ? "Sign in" : "Create account";
    setAuthMessage("");
  });

  authEls.form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await submitAuthForm(supabase);
  });
}

async function handleAuthCallback(supabase) {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return;

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    setAuthMessage(error.message);
    return;
  }
  const base = location.href.replace(/auth\/callback\.html.*$/, "");
  location.replace(base);
}

async function submitAuthForm(supabase) {
  const email = authEls.email?.value.trim();
  const password = authEls.password?.value;
  if (!email || !password) return;

  authEls.submit.disabled = true;
  setAuthMessage("");

  if (mode === "signup") {
    const redirectTo = new URL("auth/callback.html", location.href).href;
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: redirectTo },
    });
    authEls.submit.disabled = false;
    setAuthMessage(error ? error.message : "Check your email to confirm, then sign in.");
    return;
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  authEls.submit.disabled = false;
  if (error) {
    setAuthMessage(error.message);
    return;
  }
  closeAuthModal();
}

export async function signOut() {
  const supabase = getSupabase();
  if (supabase) await supabase.auth.signOut();
  currentUser = null;
  updateAuthChrome();
  notify();
}

export function requireAuthMessage() {
  return "Sign in to save books and use your reading list.";
}
