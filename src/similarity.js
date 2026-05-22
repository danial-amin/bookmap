const STOP = new Set(
  "a an the and or of in on at to for with from by is are was were be been being as it its this that these those into about over after before through during".split(
    " "
  )
);

export const SIM_ALGO_VERSION = 2;

/** Junk / ultra-generic Open Library subject labels. */
const BORING_SUBJECTS = new Set([
  "accessible book",
  "protected daisy",
  "fiction",
  "nonfiction",
  "non-fiction",
  "books",
  "literature",
  "english literature",
  "american literature",
  "large type books",
  "audiobooks",
  "ebooks",
  "open library staff picks",
  "in library",
  "juvenile literature",
  "children's stories",
  "childrens stories",
  "study guides",
  "criticism and interpretation",
  "book recommendations",
]);

const FIELD_WEIGHT = {
  title: 4,
  subjects: 3,
  content: 1,
  author: 0.2,
};

export function bookText(book) {
  return [
    book.title,
    book.author,
    ...(book.subjects || []),
    book.snippet || "",
    book.description || "",
  ]
    .join(" ")
    .toLowerCase();
}

function tokens(text) {
  return text
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Normalize OL subject strings into comparable tags. */
export function subjectTags(book) {
  if (book._subjectTags) return book._subjectTags;
  const tags = new Set();
  for (const raw of book.subjects || []) {
    if (typeof raw !== "string") continue;
    const parts = raw
      .split("/")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    for (const part of parts.slice(0, 3)) {
      const tag = part.replace(/\s+/g, " ").slice(0, 48);
      if (tag.length < 3 || tag.length > 48) continue;
      if (BORING_SUBJECTS.has(tag)) continue;
      if (/^\d{4}$/.test(tag)) continue;
      tags.add(tag);
    }
  }
  book._subjectTags = tags;
  return tags;
}

export function subjectOverlap(a, b) {
  const A = subjectTags(a);
  const B = subjectTags(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function weightedTokenCounts(book) {
  if (book._tokenCounts) return book._tokenCounts;
  const counts = new Map();
  const add = (text, weight) => {
    for (const t of tokens(String(text || ""))) {
      counts.set(t, (counts.get(t) || 0) + weight);
    }
  };

  add(book.title, FIELD_WEIGHT.title);
  add(book.title.replace(/^the\s+/i, ""), FIELD_WEIGHT.title * 0.5);

  for (const tag of subjectTags(book)) {
    for (const t of tokens(tag)) {
      counts.set(t, (counts.get(t) || 0) + FIELD_WEIGHT.subjects);
    }
  }
  for (const raw of book.subjects || []) {
    add(raw, FIELD_WEIGHT.subjects * 0.35);
  }

  add(book.author, FIELD_WEIGHT.author);
  add([book.snippet, book.description].filter(Boolean).join(" "), FIELD_WEIGHT.content);

  book._tokenCounts = counts;
  return counts;
}

function buildCorpusIdf(books) {
  const df = new Map();
  const n = books.length;
  for (const book of books) {
    const seen = new Set();
    for (const t of weightedTokenCounts(book).keys()) {
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  return { df, n };
}

function toTfidfVector(counts, idfData) {
  const vec = new Map();
  for (const [t, tf] of counts) {
    const docFreq = idfData.df.get(t) || 0;
    const idf = Math.log(1 + idfData.n / (1 + docFreq));
    vec.set(t, tf * idf);
  }
  return vec;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  const smaller = a.size < b.size ? a : b;
  const other = a.size < b.size ? b : a;
  for (const [k, v] of smaller) {
    if (other.has(k)) dot += v * other.get(k);
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function scorePair(center, other, textSim) {
  const subSim = subjectOverlap(center, other);
  let score = 0.52 * textSim + 0.43 * subSim;

  if (center.description && other.description && textSim > 0.04) {
    score += 0.04;
  }

  const sameAuthor =
    center.author &&
    other.author &&
    center.author !== "Unknown" &&
    center.author === other.author;

  if (sameAuthor) {
    if (subSim >= 0.2) score += 0.06;
    else if (subSim < 0.1) score *= 0.68;
  }

  if (score < 0.02) return 0;
  return Math.round(Math.min(1, score) * 10000) / 10000;
}

function preparePool(pool) {
  const idfData = buildCorpusIdf(pool);
  return pool.map((book) => ({
    book,
    vec: toTfidfVector(weightedTokenCounts(book), idfData),
  }));
}

function rankFromPrepared(centerIdx, prepared, k) {
  const center = prepared[centerIdx];
  const scores = [];
  for (let j = 0; j < prepared.length; j++) {
    if (j === centerIdx) continue;
    const other = prepared[j];
    const textSim = cosine(center.vec, other.vec);
    const sim = scorePair(center.book, other.book, textSim);
    if (sim > 0) {
      scores.push({ id: other.book.id, similarity: sim, book: other.book });
    }
  }
  scores.sort((a, b) => b.similarity - a.similarity);
  return scores.slice(0, k);
}

function rankPool(center, pool, k) {
  const centerIdx = pool.findIndex((b) => b.id === center.id);
  const list = centerIdx >= 0 ? pool : [center, ...pool];
  const idx = centerIdx >= 0 ? centerIdx : 0;
  const prepared = preparePool(list);
  return rankFromPrepared(idx, prepared, k);
}

/** @deprecated No-op; kept so callers do not break. */
export function attachVectors(_books) {}

export function computeNeighbors(books, k = 40) {
  const prepared = preparePool(books);
  for (let i = 0; i < prepared.length; i++) {
    prepared[i].book.neighbors = rankFromPrepared(i, prepared, k).map(({ id, similarity }) => ({
      id,
      similarity,
    }));
  }
}

/** Simple force layout from neighbor similarities → normalized x,y in [0,1]. */
export function computeLayout(books, iterations = 45) {
  const n = books.length;
  if (n < 2) return;

  const idx = new Map(books.map((b, i) => [b.id, i]));
  const pos = books.map((b, i) => {
    if (typeof b.x === "number" && typeof b.y === "number") {
      return { x: b.x, y: b.y };
    }
    const angle = (i / n) * Math.PI * 2;
    return { x: 0.5 + Math.cos(angle) * 0.35, y: 0.5 + Math.sin(angle) * 0.35 };
  });

  const attract = [];
  for (const book of books) {
    const i = idx.get(book.id);
    for (const nbr of (book.neighbors || []).slice(0, 24)) {
      const j = idx.get(nbr.id);
      if (j == null) continue;
      attract.push({ i, j, w: nbr.similarity });
    }
  }

  for (let t = 0; t < iterations; t++) {
    const forces = pos.map(() => ({ x: 0, y: 0 }));

    for (const { i, j, w } of attract) {
      const dx = pos[j].x - pos[i].x;
      const dy = pos[j].y - pos[i].y;
      const dist = Math.hypot(dx, dy) + 0.001;
      const f = w * 0.02;
      forces[i].x += (dx / dist) * f;
      forces[i].y += (dy / dist) * f;
      forces[j].x -= (dx / dist) * f;
      forces[j].y -= (dy / dist) * f;
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const dist = Math.hypot(dx, dy) + 0.0001;
        if (dist < 0.08) {
          const rep = (0.08 - dist) * 0.12;
          forces[i].x -= (dx / dist) * rep;
          forces[i].y -= (dy / dist) * rep;
          forces[j].x += (dx / dist) * rep;
          forces[j].y += (dy / dist) * rep;
        }
      }
    }

    const cooling = 1 - t / iterations;
    for (let i = 0; i < n; i++) {
      pos[i].x += forces[i].x * cooling;
      pos[i].y += forces[i].y * cooling;
      pos[i].x = Math.max(0.02, Math.min(0.98, pos[i].x));
      pos[i].y = Math.max(0.02, Math.min(0.98, pos[i].y));
    }
  }

  for (const book of books) {
    const i = idx.get(book.id);
    book.x = Math.round(pos[i].x * 100000) / 100000;
    book.y = Math.round(pos[i].y * 100000) / 100000;
  }
}

export function refreshBookGraph(books, { relayout = false } = {}) {
  for (const b of books) {
    delete b._tokenCounts;
    delete b._subjectTags;
  }
  computeNeighbors(books);
  const hasLayout = books.every((b) => typeof b.x === "number" && typeof b.y === "number");
  if (relayout || !hasLayout) computeLayout(books);
}

export function neighborsForBook(book, books, k = 40) {
  const pool = books.some((b) => b.id === book.id) ? books : [book, ...books];
  return rankPool(book, pool, k);
}

/** Rank candidate books by similarity to a center book. */
export function rankSimilarBooks(center, candidates, k = 40) {
  return rankPool(center, candidates, k);
}

export function clearBookFeatureCache(book) {
  delete book._tokenCounts;
  delete book._subjectTags;
}
