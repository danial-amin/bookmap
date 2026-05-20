const OL = "https://openlibrary.org";
const UA = "Bookmap/1.0 (danial-amin; Open Library client)";

const SKIP_TITLE =
  /\b(study guide|sparknotes|cliffsnotes|summary of|analysis of|workbook|teacher'?s guide|exam prep|poster book|colouring book|coloring book)\b/i;

const SUBJECT_SHELVES = [
  "fiction",
  "science_fiction",
  "fantasy",
  "mystery",
  "romance",
  "biography",
  "history",
  "classics",
];

export function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeWorkKey(key) {
  if (!key) return null;
  if (key.startsWith("/works/")) return key;
  if (/^OL\d+W$/i.test(key)) return `/works/${key}`;
  return null;
}

function isUsableTitle(title) {
  return title && !SKIP_TITLE.test(title);
}

export function docFromSearchHit(doc) {
  const workKey = normalizeWorkKey(doc.key);
  if (!workKey || !isUsableTitle(doc.title) || !doc.author_name?.[0]) return null;

  const author = doc.author_name[0];
  const subjects = (doc.subject || []).filter((s) => typeof s === "string").slice(0, 14);
  const sentences = doc.first_sentence;
  const snippet = Array.isArray(sentences)
    ? sentences.filter((s) => typeof s === "string").join(" ").slice(0, 600)
    : "";

  return {
    id: slug(`${doc.title}-${author}`),
    title: doc.title,
    author,
    year: doc.first_publish_year ?? null,
    cover_i: doc.cover_i ?? null,
    open_library_key: workKey,
    subjects,
    description: "",
    snippet,
    source: "openlibrary:search",
    ratings_count: doc.ratings_count ?? null,
  };
}

export function docFromSubjectWork(work, subject) {
  if (!isUsableTitle(work.title)) return null;
  const workKey = normalizeWorkKey(work.key);
  if (!workKey) return null;

  let author = "Unknown";
  if (work.authors?.[0]?.name) author = work.authors[0].name;
  else if (work.author_name?.[0]) author = work.author_name[0];

  const subjects = (work.subject || []).filter((s) => typeof s === "string").slice(0, 14);

  return {
    id: slug(`${work.title}-${author}`),
    title: work.title,
    author,
    year: null,
    cover_i: work.cover_id ?? null,
    open_library_key: workKey,
    subjects,
    description: "",
    snippet: "",
    source: `openlibrary:subject:${subject}`,
    ratings_count: null,
  };
}

async function olFetch(path, params = {}, attempt = 0) {
  const url = new URL(path.startsWith("http") ? path : `${OL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.set(k, String(v));
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Open Library HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (attempt < 2) {
      await sleep(400 * (attempt + 1));
      return olFetch(path, params, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchReadinglog(offset, limit = 100) {
  const data = await olFetch("/search.json", {
    q: "language:eng",
    sort: "readinglog",
    limit,
    offset,
    fields:
      "key,title,author_name,first_publish_year,cover_i,subject,first_sentence,ratings_count",
  });
  return (data.docs || []).map(docFromSearchHit).filter(Boolean);
}

export async function fetchSubjectWorks(subject, offset = 0, limit = 50) {
  const data = await olFetch(`/subjects/${subject}.json`, { limit, offset });
  return (data.works || [])
    .map((w) => docFromSubjectWork(w, subject))
    .filter(Boolean);
}

export async function searchBooks(query, limit = 12) {
  const data = await olFetch("/search.json", {
    q: query,
    language: "eng",
    limit,
    fields:
      "key,title,author_name,first_publish_year,cover_i,subject,first_sentence,ratings_count",
  });
  return (data.docs || []).map(docFromSearchHit).filter(Boolean);
}

function normalizeTitle(s) {
  return s
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleMatchScore(query, title) {
  if (title === query) return 100;
  if (title.startsWith(query) || query.startsWith(title)) {
    return 85 - Math.min(20, Math.abs(title.length - query.length));
  }
  if (title.includes(query)) return 70 - Math.min(30, title.length - query.length);
  const words = query.split(" ").filter((w) => w.length > 2);
  if (!words.length) return 0;
  const hits = words.filter((w) => title.includes(w)).length;
  return (hits / words.length) * 55;
}

/** Pick the hit that best matches what the user typed (not merely the first API result). */
export function pickBestSearchMatch(query, hits) {
  if (!hits?.length) return null;
  const nq = normalizeTitle(query.trim());
  const exact = hits.filter((h) => normalizeTitle(h.title) === nq);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    exact.sort((a, b) => a.title.length - b.title.length);
    return exact[0];
  }

  let best = null;
  let bestScore = -1;
  for (const h of hits) {
    const score = titleMatchScore(nq, normalizeTitle(h.title));
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return bestScore >= 28 ? best : hits[0];
}

/** Pull more related works from Open Library (author + subjects), not just the local map set. */
export async function fetchRelatedBooks(book, limit = 50) {
  const seen = new Set([book.id]);
  const out = [];

  const addHits = (hits) => {
    for (const h of hits) {
      if (!seen.has(h.id)) {
        seen.add(h.id);
        out.push(h);
      }
    }
  };

  if (book.author && book.author !== "Unknown") {
    try {
      addHits(await searchBooks(`author_name:"${book.author}"`, 35));
    } catch {
      /* skip */
    }
    await sleep(80);
  }

  for (const raw of (book.subjects || []).slice(0, 4)) {
    if (out.length >= limit) break;
    const subject = raw.split("/")[0].trim().slice(0, 48);
    if (subject.length < 4) continue;
    try {
      addHits(await searchBooks(`subject:"${subject}"`, 30));
    } catch {
      /* skip */
    }
    await sleep(80);
  }

  if (out.length < 12) {
    try {
      addHits(await searchBooks(book.title, 20));
    } catch {
      /* skip */
    }
  }

  return out.slice(0, limit);
}

export async function fetchWorkDescription(workKey) {
  const key = normalizeWorkKey(workKey);
  if (!key) return { description: "", subjects: [] };
  const work = await olFetch(`${key}.json`);
  let description = work.description;
  if (description && typeof description === "object") {
    description = description.value || "";
  }
  const subjects = (work.subjects || []).filter((s) => typeof s === "string").slice(0, 14);
  return { description: (description || "").slice(0, 1200), subjects };
}

const CACHE_KEY = "bookmap-catalog-v4";
const CACHE_TTL_MS = 1000 * 60 * 60 * 12;

export function clearCatalogCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

function isValidCachedBook(book) {
  return (
    book &&
    typeof book.id === "string" &&
    typeof book.title === "string" &&
    typeof book.author === "string" &&
    typeof book.x === "number" &&
    typeof book.y === "number" &&
    Array.isArray(book.neighbors)
  );
}

export function loadCatalogCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, books } = JSON.parse(raw);
    if (Date.now() - at > CACHE_TTL_MS) return null;
    if (!Array.isArray(books) || books.length < 20) return null;
    if (!isValidCachedBook(books[0])) return null;
    return books;
  } catch {
    return null;
  }
}

export function saveCatalogCache(books) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ at: Date.now(), books: books.map(stripForCache) })
    );
  } catch {
    /* quota */
  }
}

function stripForCache(b) {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    year: b.year,
    cover_i: b.cover_i,
    open_library_key: b.open_library_key,
    subjects: b.subjects,
    description: b.description,
    snippet: b.snippet,
    source: b.source,
    x: b.x,
    y: b.y,
    neighbors: b.neighbors,
  };
}

/**
 * Load a live catalog from Open Library (reading-list popularity + subject shelves).
 */
export async function loadLiveCatalog({ target = 400, onProgress } = {}) {
  const cached = loadCatalogCache();
  if (cached?.length >= 50) {
    onProgress?.(`Loaded ${cached.length} books (cached).`);
    return cached;
  }

  const byId = new Map();
  const add = (list) => {
    for (const b of list) {
      if (!byId.has(b.id)) byId.set(b.id, b);
    }
  };

  onProgress?.("Fetching popular books from Open Library…");
  for (let offset = 0; offset < 900 && byId.size < target; offset += 100) {
    try {
      const batch = await searchReadinglog(offset, 100);
      add(batch);
      onProgress?.(`Popular books: ${byId.size}…`);
      if (batch.length < 100) break;
    } catch (err) {
      console.warn("readinglog page failed", offset, err);
      if (byId.size >= 20) break;
    }
    await sleep(150);
  }

  onProgress?.("Adding books from subject shelves…");
  const perShelf = Math.ceil((target - byId.size) / SUBJECT_SHELVES.length) + 15;
  for (const subject of SUBJECT_SHELVES) {
    if (byId.size >= target) break;
    try {
      const batch = await fetchSubjectWorks(subject, 0, Math.min(perShelf, 80));
      add(batch);
      onProgress?.(`Subject “${subject}”: ${byId.size} books…`);
    } catch (err) {
      console.warn("subject fetch failed", subject, err);
    }
    await sleep(150);
  }

  const books = [...byId.values()];
  if (books.length < 10) {
    throw new Error("Open Library returned too few books");
  }

  return books;
}

export async function loadStaticFallback() {
  const res = await fetch("./data/books.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Static fallback unavailable");
  const data = await res.json();
  const books = data.books || [];
  if (books.length < 10) throw new Error("Static fallback empty");
  return books;
}

export async function enrichBooks(books, { limit = 80, onProgress } = {}) {
  const need = books.filter((b) => !b.description && b.open_library_key).slice(0, limit);
  let done = 0;
  for (const book of need) {
    try {
      const { description, subjects } = await fetchWorkDescription(book.open_library_key);
      if (description) book.description = description;
      if (subjects.length) book.subjects = subjects;
    } catch {
      /* skip */
    }
    done += 1;
    if (done % 10 === 0) {
      onProgress?.(`Descriptions: ${done}/${need.length}…`);
    }
    await sleep(100);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
