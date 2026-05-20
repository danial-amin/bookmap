const STOP = new Set(
  "a an the and or of in on at to for with from by is are was were be been being as it its this that these those".split(
    " "
  )
);

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

function vectorize(text) {
  const vec = new Map();
  for (const t of tokens(text)) {
    vec.set(t, (vec.get(t) || 0) + 1);
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

export function attachVectors(books) {
  for (const book of books) {
    book._vec = vectorize(bookText(book));
  }
}

export function computeNeighbors(books, k = 48) {
  for (const book of books) {
    const scores = [];
    for (const other of books) {
      if (other.id === book.id) continue;
      const sim = cosine(book._vec, other._vec);
      if (sim > 0) scores.push({ id: other.id, similarity: Math.round(sim * 10000) / 10000 });
    }
    scores.sort((a, b) => b.similarity - a.similarity);
    book.neighbors = scores.slice(0, k);
  }
}

/** Simple force layout from neighbor similarities → normalized x,y in [0,1]. */
export function computeLayout(books, iterations = 70) {
  const n = books.length;
  const idx = new Map(books.map((b, i) => [b.id, i]));
  const pos = books.map((_, i) => {
    const angle = (i / n) * Math.PI * 2;
    return { x: 0.5 + Math.cos(angle) * 0.35, y: 0.5 + Math.sin(angle) * 0.35 };
  });

  const attract = [];
  for (const book of books) {
    const i = idx.get(book.id);
    for (const nbr of book.neighbors || []) {
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
          const rep = (0.08 - dist) * 0.15;
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
    book.x = Math.round(pos[idx.get(book.id)].x * 100000) / 100000;
    book.y = Math.round(pos[idx.get(book.id)].y * 100000) / 100000;
    delete book._vec;
  }
}

export function refreshBookGraph(books) {
  attachVectors(books);
  computeNeighbors(books);
  computeLayout(books);
}

export function neighborsForBook(book, books, k = 48) {
  const pool = books.some((b) => b.id === book.id) ? books : [book, ...books];
  attachVectors(pool);
  const scores = [];
  for (const other of pool) {
    if (other.id === book.id) continue;
    const sim = cosine(book._vec, other._vec);
    if (sim > 0) scores.push({ id: other.id, similarity: Math.round(sim * 10000) / 10000 });
  }
  scores.sort((a, b) => b.similarity - a.similarity);
  for (const b of pool) delete b._vec;
  return scores.slice(0, k);
}

/** Rank candidate books by text similarity to a center book. */
export function rankSimilarBooks(center, candidates, k = 48) {
  attachVectors([center, ...candidates]);
  const scores = [];
  for (const other of candidates) {
    if (other.id === center.id) continue;
    const sim = cosine(center._vec, other._vec);
    scores.push({ id: other.id, similarity: Math.round(sim * 10000) / 10000, book: other });
  }
  delete center._vec;
  for (const b of candidates) delete b._vec;
  scores.sort((a, b) => b.similarity - a.similarity);
  return scores.slice(0, k);
}
