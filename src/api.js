import { subjectTags, refreshBookGraph, SIM_ALGO_VERSION } from "./similarity.js";

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
  if (!workKey || !isUsableTitle(doc.title)) return null;

  const author = doc.author_name?.[0] || "Unknown";
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

const CORS_PROXY = "https://api.allorigins.win/raw?url=";

async function olFetchDirect(url, signal) {
  const res = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Open Library HTTP ${res.status}`);
  return res.json();
}

async function olFetchViaProxy(url, signal) {
  const proxyUrl = CORS_PROXY + encodeURIComponent(url);
  const res = await fetch(proxyUrl, { signal });
  if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
  const wrapper = await res.json();
  if (wrapper.status?.http_code && wrapper.status.http_code >= 400) {
    throw new Error(`Open Library HTTP ${wrapper.status.http_code}`);
  }
  const body = wrapper.contents;
  return typeof body === "string" ? JSON.parse(body) : body;
}

async function olFetch(path, params = {}, attempt = 0) {
  const url = new URL(path.startsWith("http") ? path : `${OL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.set(k, String(v));
  });

  const timeoutMs = params.limit && params.limit <= 25 ? 10000 : 18000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    try {
      return await olFetchDirect(url.toString(), controller.signal);
    } catch (directErr) {
      return await olFetchViaProxy(url.toString(), controller.signal);
    }
  } catch (err) {
    if (attempt < 1) {
      await sleep(300);
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

const SEARCH_FIELDS =
  "key,title,author_name,first_publish_year,cover_i,subject,first_sentence,ratings_count";

async function searchBooksOnce(q, limit) {
  const data = await olFetch("/search.json", {
    q,
    limit,
    fields: SEARCH_FIELDS,
  });
  return (data.docs || []).map(docFromSearchHit).filter(Boolean);
}

/** User search: one fast request, then optional fallbacks. */
export async function searchBooks(query, limit = 20) {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const primary = await searchBooksOnce(trimmed, limit);
    if (primary.length) return primary;
  } catch (err) {
    console.warn("Primary search failed:", err);
  }

  for (const q of [`${trimmed} language:eng`, `title:${trimmed}`]) {
    try {
      const batch = await searchBooksOnce(q, limit);
      if (batch.length) return batch;
    } catch (err) {
      console.warn("Search fallback failed:", q, err);
    }
  }

  return [];
}

function normalizeTitle(s) {
  return s
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingArticle(s) {
  return s.replace(/^(the|a|an)\s+/, "");
}

function stripEditionSuffix(title) {
  return title.replace(/\s*\([^)]*\)\s*$/g, "").trim();
}

function titleMatchScore(query, title) {
  if (title === query) return 100;
  if (title.startsWith(query) || query.startsWith(title)) {
    return 88 - Math.min(24, Math.abs(title.length - query.length));
  }
  if (title.includes(query)) return 72 - Math.min(32, title.length - query.length);
  if (query.includes(title) && title.length >= 4) {
    return 65 - Math.min(20, query.length - title.length);
  }
  const words = query.split(" ").filter((w) => w.length > 2);
  if (!words.length) return 0;
  const hits = words.filter((w) => title.includes(w)).length;
  let score = (hits / words.length) * 58;
  if (hits === words.length && title.length > query.length + 12) {
    score -= 12;
  }
  return score;
}

function searchHitScore(query, hit) {
  const rawQ = normalizeTitle(query.trim());
  const rawT = normalizeTitle(hit.title);
  const coreT = normalizeTitle(stripEditionSuffix(hit.title));

  let score = Math.max(
    titleMatchScore(rawQ, rawT),
    titleMatchScore(rawQ, coreT),
    titleMatchScore(stripLeadingArticle(rawQ), stripLeadingArticle(rawT)),
    titleMatchScore(stripLeadingArticle(rawQ), stripLeadingArticle(coreT))
  );

  if (SKIP_TITLE.test(hit.title)) score -= 60;

  const lenRatio = rawT.length / Math.max(rawQ.length, 1);
  if (lenRatio > 2.2) score -= 18;
  else if (lenRatio > 1.6) score -= 8;

  if (hit.ratings_count > 20) {
    score += Math.min(14, Math.log10(hit.ratings_count + 1) * 5);
  }
  if (hit.cover_i) score += 4;
  if (hit.first_publish_year && hit.first_publish_year > 1990 && hit.first_publish_year < 2030) {
    score += 1;
  }

  return score;
}

/** Pick the hit that best matches what the user typed (not merely the first API result). */
export function pickBestSearchMatch(query, hits) {
  if (!hits?.length) return null;
  const nq = normalizeTitle(query.trim());

  const exact = hits.filter((h) => {
    const t = normalizeTitle(h.title);
    const core = normalizeTitle(stripEditionSuffix(h.title));
    return t === nq || core === nq;
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    exact.sort((a, b) => (b.ratings_count || 0) - (a.ratings_count || 0) || a.title.length - b.title.length);
    return exact[0];
  }

  let best = null;
  let bestScore = -1;
  for (const h of hits) {
    const score = searchHitScore(query, h);
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return bestScore >= 32 ? best : hits[0];
}

function relatedSubjectQueries(book) {
  const tags = [...subjectTags(book)];
  const queries = [];
  for (const tag of tags.slice(0, 3)) {
    queries.push(`subject:"${tag}"`);
  }
  for (const raw of (book.subjects || []).slice(0, 2)) {
    const head = raw.split("/")[0].trim().slice(0, 40);
    if (head.length >= 4 && !queries.some((q) => q.includes(head))) {
      queries.push(`subject:"${head}"`);
    }
  }
  return queries;
}

/** Pull related works: subjects first (thematic), then a small author slice. */
export async function fetchRelatedBooks(book, limit = 36) {
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

  const subjectQueries = relatedSubjectQueries(book).slice(0, 3);
  const subjectFetches = subjectQueries.map((q) =>
    searchBooksOnce(q, 18).catch(() => [])
  );
  if (book.author && book.author !== "Unknown") {
    subjectFetches.push(
      searchBooksOnce(`author_name:"${book.author}"`, 10).catch(() => [])
    );
  }

  const batches = await Promise.all(subjectFetches);
  for (const hits of batches) {
    addHits(hits);
    if (out.length >= limit) break;
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

const CACHE_KEY = "bookmap-catalog-v6";
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
    const { at, books, simVersion } = JSON.parse(raw);
    if (Date.now() - at > CACHE_TTL_MS) return null;
    if (!Array.isArray(books) || books.length < 20) return null;
    if (!isValidCachedBook(books[0])) return null;
    return { books, simVersion: simVersion ?? 0 };
  } catch {
    return null;
  }
}

export function saveCatalogCache(books) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        at: Date.now(),
        simVersion: SIM_ALGO_VERSION,
        books: books.map(stripForCache),
      })
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
export async function loadLiveCatalog({ target = 280, onProgress } = {}) {
  const cached = loadCatalogCache();
  if (cached?.books?.length >= 50) {
    const { books, simVersion } = cached;
    if (simVersion === SIM_ALGO_VERSION && books[0]?.neighbors?.length) {
      onProgress?.(`Loaded ${books.length} books from cache.`);
      return books;
    }
    onProgress?.(`Loaded ${books.length} books from cache.`);
    return books;
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

export async function enrichBooks(books, { limit = 20, onProgress } = {}) {
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
