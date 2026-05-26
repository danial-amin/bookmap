import { getSupabase, isSupabaseConfigured } from "./lib/supabase.js";

/**
 * Check if the books table with embeddings exists in Supabase.
 * Returns true if we can use vector search, false if we should fall back to TF-IDF.
 */
export async function hasVectorCatalog() {
  if (!isSupabaseConfigured()) return false;
  const supabase = getSupabase();
  if (!supabase) return false;

  try {
    const { count, error } = await supabase
      .from("books")
      .select("id", { count: "exact", head: true });
    if (error) return false;
    return (count ?? 0) >= 20;
  } catch {
    return false;
  }
}

/**
 * Load catalog from Supabase books table (without embeddings — just metadata).
 */
export async function loadVectorCatalog({ limit = 400, onProgress } = {}) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase not configured");

  onProgress?.("Loading books from database...");
  const { data, error } = await supabase
    .from("books")
    .select("id, title, author, year, cover_i, subjects, description, open_library_key")
    .not("embedding", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  if (!data?.length) throw new Error("No books with embeddings in database");

  onProgress?.(`Loaded ${data.length} books from vector catalog.`);
  return data.map((row) => ({
    id: row.id,
    title: row.title,
    author: row.author,
    year: row.year,
    cover_i: row.cover_i,
    subjects: row.subjects || [],
    description: row.description || "",
    snippet: "",
    open_library_key: row.open_library_key,
    source: "supabase:vector",
  }));
}

/**
 * Find similar books using pgvector cosine similarity.
 * Queries by book ID (looks up that book's embedding, then finds nearest neighbors).
 */
export async function findSimilarByBookId(bookId, { limit = 30, excludeIds = [] } = {}) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data: embedding } = await supabase.rpc("get_book_embedding", {
    book_id: bookId,
  });

  if (!embedding) return null;

  const { data, error } = await supabase.rpc("find_similar_books", {
    query_embedding: embedding,
    match_count: limit,
    exclude_ids: [bookId, ...excludeIds],
  });

  if (error) {
    console.warn("Vector search failed:", error);
    return null;
  }

  return (data || []).map((row) => ({
    id: row.id,
    title: row.title,
    author: row.author,
    year: row.year,
    cover_i: row.cover_i,
    subjects: row.subjects || [],
    description: row.description || "",
    snippet: "",
    open_library_key: row.open_library_key,
    similarity: Math.round((row.similarity ?? 0) * 10000) / 10000,
  }));
}

/**
 * Search the vector catalog by title (full-text search in Supabase).
 */
export async function searchVectorCatalog(query, limit = 20) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase.rpc("search_books_by_title", {
    query,
    match_count: limit,
  });

  if (error) {
    console.warn("Title search failed:", error);
    return null;
  }

  return (data || []).map((row) => ({
    id: row.id,
    title: row.title,
    author: row.author,
    year: row.year,
    cover_i: row.cover_i,
    subjects: row.subjects || [],
    description: row.description || "",
    snippet: "",
    open_library_key: row.open_library_key,
    source: "supabase:search",
  }));
}
