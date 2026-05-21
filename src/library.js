import { getSupabase } from "./lib/supabase.js";
import { getUser } from "./auth.js";

/** @typedef {'read'|'reading'|'want'} BookStatus */

let cache = [];

export function getLibraryBooks() {
  return cache;
}

export function getReadBooks() {
  return cache.filter((b) => b.status === "read");
}

export function isInLibrary(bookmapId) {
  return cache.some((b) => b.bookmap_id === bookmapId);
}

export function bookToRow(book, status = "read") {
  return {
    bookmap_id: book.id,
    open_library_key: book.open_library_key || null,
    title: book.title,
    author: book.author || "Unknown",
    year: book.year ?? null,
    cover_i: book.cover_i ?? null,
    status,
  };
}

export function rowToBook(row) {
  return {
    id: row.bookmap_id,
    title: row.title,
    author: row.author,
    year: row.year,
    cover_i: row.cover_i,
    open_library_key: row.open_library_key,
    subjects: [],
    description: "",
    snippet: "",
    status: row.status,
    libraryId: row.id,
  };
}

export async function loadLibrary() {
  const supabase = getSupabase();
  const user = getUser();
  if (!supabase || !user) {
    cache = [];
    return cache;
  }

  const { data, error } = await supabase
    .from("user_books")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) throw error;
  cache = data || [];
  return cache;
}

export async function addBookToLibrary(book, status = "read") {
  const supabase = getSupabase();
  const user = getUser();
  if (!supabase || !user) throw new Error("Not signed in");

  const row = { ...bookToRow(book, status), user_id: user.id };
  const { data, error } = await supabase
    .from("user_books")
    .upsert(row, { onConflict: "user_id,bookmap_id" })
    .select()
    .single();

  if (error) throw error;
  await loadLibrary();
  return data;
}

export async function removeFromLibrary(bookmapId) {
  const supabase = getSupabase();
  const user = getUser();
  if (!supabase || !user) throw new Error("Not signed in");

  const { error } = await supabase
    .from("user_books")
    .delete()
    .eq("user_id", user.id)
    .eq("bookmap_id", bookmapId);

  if (error) throw error;
  await loadLibrary();
}

export async function setBookStatus(bookmapId, status) {
  const supabase = getSupabase();
  const user = getUser();
  if (!supabase || !user) throw new Error("Not signed in");

  const { error } = await supabase
    .from("user_books")
    .update({ status })
    .eq("user_id", user.id)
    .eq("bookmap_id", bookmapId);

  if (error) throw error;
  await loadLibrary();
}

export function pickRandomReadBook() {
  const read = getReadBooks();
  if (!read.length) return null;
  return rowToBook(read[Math.floor(Math.random() * read.length)]);
}

export function filterUnreadCandidates(books) {
  const readIds = new Set(getReadBooks().map((b) => b.bookmap_id));
  return books.filter((b) => !readIds.has(b.id));
}
