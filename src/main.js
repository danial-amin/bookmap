import {
  loadLiveCatalog,
  loadStaticFallback,
  clearCatalogCache,
  enrichBooks,
  searchBooks,
  pickBestSearchMatch,
  fetchRelatedBooks,
  fetchWorkDescription,
  saveCatalogCache,
} from "./api.js";
import { refreshBookGraph, neighborsForBook, rankSimilarBooks } from "./similarity.js";
import {
  hasVectorCatalog,
  loadVectorCatalog,
  findSimilarByBookId,
  searchVectorCatalog,
} from "./vectors.js";
import {
  bindAuthElements,
  initAuth,
  onAuthChange,
  getUser,
  openAuthModal,
  requireAuthMessage,
} from "./auth.js";
import {
  loadLibrary,
  getLibraryBooks,
  getReadBooks,
  isInLibrary,
  addBookToLibrary,
  removeFromLibrary,
  setBookStatus,
  pickRandomReadBook,
  rowToBook,
} from "./library.js";

const WORLD = 1000;
const LABEL_MIN_SCALE = 0.35;
const LABEL_MAX_SCALE = 2.2;
/** Search-mode ring layout: closest / farthest neighbor distance (world units). */
const RING_RADIUS_MIN = 42;
const RING_RADIUS_MAX = 175;

const state = {
  books: [],
  byId: new Map(),
  ready: false,
  camera: { x: WORLD / 2, y: WORLD / 2, scale: 0.85 },
  mode: "explore",
  centerId: null,
  neighborIds: new Set(),
  dragging: false,
  dragLast: null,
  selectedId: null,
  animId: null,
  lastSearchQuery: null,
  radialNeighbors: [],
  discoveryMode: "similar",
  libraryTab: "read",
  useVectors: false,
};

const els = {
  canvas: document.getElementById("map-canvas"),
  labels: document.getElementById("map-labels"),
  wrap: document.getElementById("map-wrap"),
  form: document.getElementById("search-form"),
  input: document.getElementById("search-input"),
  status: document.getElementById("status"),
  mapMain: document.getElementById("map-main"),
  detail: document.getElementById("detail"),
  detailBackdrop: document.getElementById("detail-backdrop"),
  detailTitle: document.getElementById("detail-title"),
  detailAuthor: document.getElementById("detail-author"),
  detailBlurb: document.getElementById("detail-blurb"),
  detailCover: document.getElementById("detail-cover"),
  detailQueryNote: document.getElementById("detail-query-note"),
  detailSimilar: document.getElementById("detail-similar"),
  detailLink: document.getElementById("detail-link"),
  detailClose: document.getElementById("detail-close"),
  loader: document.getElementById("loader"),
  loaderDetail: document.getElementById("loader-detail"),
  exploreBtn: document.getElementById("explore-btn"),
  brandHome: document.getElementById("brand-home"),
  submitBtn: document.querySelector(".btn-primary"),
  retryBtn: document.getElementById("retry-btn"),
  discoveryRow: document.getElementById("discovery-row"),
  discoveryChips: document.querySelectorAll("[data-discovery]"),
  fromReadsBtn: document.getElementById("from-reads-btn"),
  libraryBtn: document.getElementById("library-btn"),
  libraryPanel: document.getElementById("library-panel"),
  libraryClose: document.getElementById("library-close"),
  libraryList: document.getElementById("library-list"),
  libraryEmpty: document.getElementById("library-empty"),
  libraryTabs: document.querySelectorAll(".library-tab"),
  libraryActions: document.getElementById("library-actions"),
  libraryActionMsg: document.getElementById("library-action-msg"),
  removeLibraryBtn: document.getElementById("remove-library-btn"),
  detailSimilarHeading: document.getElementById("detail-similar-heading"),
};

const ctx = els.canvas.getContext("2d");
let labelNodes = new Map();

function setStatus(msg) {
  els.status.textContent = msg || "";
}

function setLoaderDetail(msg) {
  els.loaderDetail.textContent = msg || "";
}

function hideLoader() {
  els.loader.classList.add("hidden");
  els.loader.setAttribute("aria-busy", "false");
}

function setBooks(books) {
  state.books = books;
  state.byId = new Map(books.map((b) => [b.id, b]));
  state.ready = true;
}

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findLocalExactBook(query) {
  const q = normalize(query);
  if (!q) return null;
  return state.books.find((b) => normalize(b.title) === q) || null;
}

function placeNewBook(book) {
  const others = state.books.filter((b) => b.id !== book.id && b.x != null);
  book.neighbors = neighborsForBook(book, others);
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const n of book.neighbors.slice(0, 6)) {
    const o = state.byId.get(n.id);
    if (o?.x != null) {
      sx += o.x * n.similarity;
      sy += o.y * n.similarity;
      sw += n.similarity;
    }
  }
  if (sw) {
    book.x = sx / sw;
    book.y = sy / sw;
  } else {
    book.x = 0.45 + Math.random() * 0.1;
    book.y = 0.45 + Math.random() * 0.1;
  }
}

function addBook(book) {
  if (state.byId.has(book.id)) return state.byId.get(book.id);
  placeNewBook(book);
  state.books.push(book);
  state.byId.set(book.id, book);
  saveCatalogCache(state.books);
  return book;
}

function neighborAngle(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 360) * Math.PI) / 180;
}

function layoutForMode(book) {
  if (state.mode !== "search" || !book) {
    return state.books.map((b) => ({
      id: b.id,
      x: b.x * WORLD,
      y: b.y * WORLD,
      book: b,
    }));
  }

  const cx = WORLD / 2;
  const cy = WORLD / 2;
  const items = [{ id: book.id, x: cx, y: cy, book }];

  const neighbors = state.radialNeighbors.length ? state.radialNeighbors : book.neighbors || [];
  const sims = neighbors.map((n) => n.similarity ?? 0);
  const maxSim = Math.max(...sims, 0.001);
  const minSim = Math.min(...sims);

  for (const n of neighbors) {
    const other = state.byId.get(n.id);
    if (!other) continue;
    const span = maxSim - minSim || 1;
    const norm = (n.similarity - minSim) / span;
    const closeness = Math.pow(Math.min(1, Math.max(0, norm)), 0.75);
    const radius = RING_RADIUS_MIN + (1 - closeness) * (RING_RADIUS_MAX - RING_RADIUS_MIN);
    const angle = neighborAngle(n.id);
    items.push({
      id: other.id,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      book: other,
      similarity: n.similarity,
    });
  }
  return items;
}

function worldToScreen(wx, wy) {
  const rect = els.wrap.getBoundingClientRect();
  const { x: cx, y: cy, scale } = state.camera;
  return {
    x: rect.width / 2 + (wx - cx) * scale,
    y: rect.height / 2 + (wy - cy) * scale,
  };
}

function resizeCanvas() {
  const rect = els.wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  els.canvas.width = Math.floor(rect.width * dpr);
  els.canvas.height = Math.floor(rect.height * dpr);
  els.canvas.style.width = `${rect.width}px`;
  els.canvas.style.height = `${rect.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawBackground() {
  const rect = els.wrap.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  const grad = ctx.createRadialGradient(
    rect.width * 0.5,
    rect.height * 0.45,
    0,
    rect.width * 0.5,
    rect.height * 0.45,
    Math.max(rect.width, rect.height) * 0.55
  );
  grad.addColorStop(0, "rgba(154, 123, 92, 0.08)");
  grad.addColorStop(1, "rgba(246, 243, 237, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, rect.width, rect.height);

  if (state.mode === "search" && state.centerId) {
    const center = worldToScreen(WORLD / 2, WORLD / 2);
    for (let r = 50; r <= RING_RADIUS_MAX + 20; r += 45) {
      ctx.beginPath();
      ctx.arc(center.x, center.y, r * state.camera.scale, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(154, 123, 92, 0.12)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function updateLabels() {
  if (!state.ready) return;

  const layout = layoutForMode(state.centerId ? state.byId.get(state.centerId) : null);
  const rect = els.wrap.getBoundingClientRect();
  const visible = new Set();
  const minFont = 10;
  const maxShown = state.mode === "search" ? 80 : 140;

  const ranked = layout
    .map((item) => {
      const screen = worldToScreen(item.x, item.y);
      const inView =
        screen.x > -100 &&
        screen.x < rect.width + 100 &&
        screen.y > -24 &&
        screen.y < rect.height + 24;
      const isCenter = item.id === state.centerId;
      const isNear = state.neighborIds.has(item.id);
      let priority = item.similarity ?? 0;
      if (isCenter) priority = 2;
      else if (isNear) priority = 1.2 + (item.similarity || 0);
      else if (state.mode === "explore") priority = 0.2;
      return { ...item, screen, inView, isCenter, isNear, priority };
    })
    .filter((i) => i.inView)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxShown);

  for (const item of ranked) {
    visible.add(item.id);
    let node = labelNodes.get(item.id);
    if (!node) {
      node = document.createElement("button");
      node.type = "button";
      node.className = "book-label";
      node.textContent = item.book.title;
      node.addEventListener("click", (e) => {
        e.stopPropagation();
        focusBook(item.book);
      });
      labelNodes.set(item.id, node);
      els.labels.appendChild(node);
    }

    const scale = state.camera.scale;
    const fontSize = Math.min(
      15,
      Math.max(minFont, (item.isCenter ? 14 : 11) * Math.sqrt(scale))
    );
    node.style.left = `${item.screen.x}px`;
    node.style.top = `${item.screen.y}px`;
    node.style.fontSize = `${fontSize}px`;
    node.classList.toggle("center", item.isCenter);
    node.classList.toggle("near", item.isNear && !item.isCenter);
    node.classList.toggle("focused", item.id === state.selectedId);
    node.style.opacity =
      state.mode === "search" && !item.isCenter && !item.isNear ? "0.4" : "1";
  }

  for (const [id, node] of labelNodes) {
    if (!visible.has(id)) {
      node.remove();
      labelNodes.delete(id);
    }
  }
}

function render() {
  drawBackground();
  updateLabels();
}

function animateCamera(target, duration = 650) {
  const start = { ...state.camera };
  const startTime = performance.now();
  if (state.animId) cancelAnimationFrame(state.animId);

  function tick(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const ease = 1 - Math.pow(1 - t, 3);
    state.camera.x = start.x + (target.x - start.x) * ease;
    state.camera.y = start.y + (target.y - start.y) * ease;
    state.camera.scale = start.scale + (target.scale - start.scale) * ease;
    render();
    if (t < 1) state.animId = requestAnimationFrame(tick);
    else state.animId = null;
  }
  state.animId = requestAnimationFrame(tick);
}

async function ensureDescription(book) {
  if (book.description || !book.open_library_key) return;
  try {
    const { description, subjects } = await fetchWorkDescription(book.open_library_key);
    if (description) book.description = description;
    if (subjects?.length) book.subjects = subjects;
    if (state.selectedId === book.id) showDetail(book);
  } catch {
    /* ignore */
  }
}

function coverUrl(book) {
  if (!book.cover_i) return null;
  return `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`;
}

function filterRankedForDiscovery(ranked) {
  if (!getUser() || state.discoveryMode !== "new") return ranked;
  const readIds = new Set(getReadBooks().map((b) => b.bookmap_id));
  const filtered = ranked.filter((n) => !readIds.has(n.id));
  return filtered.length ? filtered : ranked;
}

function applyRadialNeighbors(book, ranked) {
  const filtered = filterRankedForDiscovery(ranked);
  state.radialNeighbors = filtered;
  book.neighbors = filtered;
  state.neighborIds = new Set(filtered.map((n) => n.id));
  renderSimilarList(book, filtered);
  render();
}

function renderSimilarList(center, ranked) {
  els.detailSimilar.innerHTML = "";
  for (const n of ranked.slice(0, 12)) {
    const other = state.byId.get(n.id);
    if (!other) continue;
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `${other.title}<span class="sim-meta">${other.author}${n.similarity ? ` · ${Math.round(n.similarity * 100)}% match` : ""}</span>`;
    btn.addEventListener("click", () => focusBook(other, other.title));
    li.appendChild(btn);
    els.detailSimilar.appendChild(li);
  }
}

async function expandSimilarVectors(book) {
  setStatus(`Finding similar books for “${book.title}” (vector search)…`);
  const excludeIds = [];
  if (getUser() && state.discoveryMode === "new") {
    for (const b of getReadBooks()) excludeIds.push(b.bookmap_id);
  }

  const results = await findSimilarByBookId(book.id, {
    limit: 36,
    excludeIds,
  });

  if (!results || !results.length) return false;

  for (const r of results) addBook(r);
  const ranked = results.map((r) => ({ id: r.id, similarity: r.similarity, book: r }));
  applyRadialNeighbors(book, ranked);

  const newHint =
    getUser() && state.discoveryMode === "new"
      ? " (excluding books you’ve already read)"
      : "";
  setStatus(
    `${ranked.length} books around “${book.title}”${newHint} — closer = more similar.`
  );
  return true;
}

async function expandSimilarFallback(book) {
  setStatus(`Finding similar books for “${book.title}”…`);
  try {
    const related = await fetchRelatedBooks(book, 36);
    for (const r of related) addBook(r);

    const merged = new Map();
    for (const r of related) {
      const b = state.byId.get(r.id);
      if (b) merged.set(b.id, b);
    }
    for (const n of book.neighbors || []) {
      const b = state.byId.get(n.id);
      if (b) merged.set(b.id, b);
    }

    let ranked = rankSimilarBooks(book, [...merged.values()]);
    ranked = ranked.filter((n) => n.similarity >= 0.06);
    applyRadialNeighbors(book, ranked);
    const shown = state.radialNeighbors.length;
    const newHint =
      getUser() && state.discoveryMode === "new"
        ? " (excluding books you’ve already read)"
        : "";
    setStatus(
      `${shown} books around “${book.title}”${newHint} — closer on the map means more alike.`
    );
  } catch (err) {
    console.warn(err);
    const fallback = neighborsForBook(book, state.books);
    applyRadialNeighbors(book, fallback);
    setStatus(`Showing ${fallback.length} similar books from the map.`);
  }
}

async function expandSimilar(book) {
  if (state.useVectors) {
    try {
      const ok = await expandSimilarVectors(book);
      if (ok) return;
    } catch (err) {
      console.warn("Vector search failed, falling back:", err);
    }
  }
  await expandSimilarFallback(book);
}

async function focusBook(book, searchedAs = null) {
  state.lastSearchQuery = searchedAs || book.title;
  state.centerId = book.id;
  state.mode = "search";
  state.selectedId = book.id;
  state.radialNeighbors = [];

  try {
    const quick = neighborsForBook(book, state.books);
    applyRadialNeighbors(book, quick);
  } catch (err) {
    console.warn("Quick neighbors failed:", err);
    book.neighbors = [];
    state.neighborIds = new Set();
  }

  els.exploreBtn.classList.remove("hidden");
  openDetailPanel(book);
  ensureDescription(book);

  els.input.value = state.lastSearchQuery;

  animateCamera({
    x: WORLD / 2,
    y: WORLD / 2,
    scale: Math.min(LABEL_MAX_SCALE, Math.max(1.2, 1.45)),
  });
  history.replaceState(null, "", `#${encodeURIComponent(book.id)}`);

  expandSimilar(book).catch((err) => console.warn(err));
}

function openDetailPanel(book) {
  els.detail.classList.remove("hidden");
  els.detailBackdrop.classList.remove("hidden");
  els.mapMain.classList.add("panel-open");

  els.detailTitle.textContent = book.title;
  els.detailAuthor.textContent = [book.author, book.year].filter(Boolean).join(" · ");
  els.detailBlurb.textContent =
    book.description || book.snippet || "Fetching details from Open Library…";

  const q = state.lastSearchQuery;
  if (q && normalize(q) !== normalize(book.title)) {
    els.detailQueryNote.classList.remove("hidden");
    els.detailQueryNote.innerHTML = `You searched for <strong>${q}</strong> — showing the closest Open Library match.`;
  } else {
    els.detailQueryNote.classList.add("hidden");
  }

  const cover = coverUrl(book);
  if (cover) {
    els.detailCover.src = cover;
    els.detailCover.alt = `Cover of ${book.title}`;
    els.detailCover.classList.remove("hidden");
  } else {
    els.detailCover.classList.add("hidden");
  }

  const key = book.open_library_key || "";
  els.detailLink.href = key
    ? `https://openlibrary.org${key}`
    : `https://openlibrary.org/search?q=${encodeURIComponent(book.title)}`;

  updateDetailLibraryActions(book);
  updateSimilarHeading();
}

function updateSimilarHeading() {
  if (!els.detailSimilarHeading) return;
  const newMode = getUser() && state.discoveryMode === "new";
  els.detailSimilarHeading.textContent = newMode
    ? "New picks for you"
    : "Similar books";
}

function updateDetailLibraryActions(book) {
  const signedIn = !!getUser();
  els.libraryActions?.classList.toggle("hidden", !signedIn);
  if (!signedIn) return;

  const inList = isInLibrary(book.id);
  els.removeLibraryBtn?.classList.toggle("hidden", !inList);
  for (const btn of document.querySelectorAll(".library-status-btn")) {
    btn.classList.toggle("active", false);
  }
  if (els.libraryActionMsg) els.libraryActionMsg.textContent = "";
}

async function handleLibraryAdd(book, status) {
  if (!getUser()) {
    openAuthModal();
    if (els.libraryActionMsg) els.libraryActionMsg.textContent = requireAuthMessage();
    return;
  }
  try {
    await addBookToLibrary(book, status);
    if (els.libraryActionMsg) {
      els.libraryActionMsg.textContent =
        status === "read"
          ? "Saved to your read list."
          : status === "reading"
            ? "Marked as currently reading."
            : "Added to want to read.";
    }
    updateDetailLibraryActions(book);
    renderLibraryPanel();
  } catch (err) {
    if (els.libraryActionMsg) els.libraryActionMsg.textContent = err.message || "Could not save.";
  }
}

function openLibraryPanel() {
  els.libraryPanel?.classList.remove("hidden");
  els.mapMain?.classList.add("library-open");
  renderLibraryPanel();
}

function closeLibraryPanel() {
  els.libraryPanel?.classList.add("hidden");
  els.mapMain?.classList.remove("library-open");
}

function renderLibraryPanel() {
  if (!els.libraryList) return;
  els.libraryList.innerHTML = "";

  const tabRows = getLibraryBooks().filter((b) => b.status === state.libraryTab);
  const empty = !tabRows.length;
  els.libraryEmpty?.classList.toggle("hidden", !empty);
  if (empty) return;

  for (const row of tabRows) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "library-item-btn";
    btn.innerHTML = `${row.title}<span class="sim-meta">${row.author}${row.year ? ` · ${row.year}` : ""}</span>`;
    btn.addEventListener("click", () => {
      const book = rowToBook(row);
      addBook(book);
      closeLibraryPanel();
      focusBook(book, book.title);
    });
    li.appendChild(btn);
    els.libraryList.appendChild(li);
  }
}

function refreshSignedInChrome() {
  const signedIn = !!getUser();
  document.body.classList.toggle("signed-in", signedIn);
  els.discoveryRow?.classList.toggle("hidden", !signedIn);
}

async function onFromReadsClick() {
  if (!getUser()) {
    openAuthModal();
    setStatus(requireAuthMessage());
    return;
  }
  const row = pickRandomReadBook();
  if (!row) {
    setStatus("Add at least one book to your read list first.");
    openLibraryPanel();
    return;
  }
  const book = addBook(row);
  await focusBook(book, book.title);
  setStatus(`Exploring from your shelf: “${book.title}”.`);
}

function hideDetail() {
  els.detail.classList.add("hidden");
  els.detailBackdrop.classList.add("hidden");
  els.mapMain.classList.remove("panel-open");
  state.selectedId = null;
}

function exploreAll() {
  state.mode = "explore";
  state.centerId = null;
  state.neighborIds.clear();
  state.radialNeighbors = [];
  state.lastSearchQuery = null;
  hideDetail();
  els.exploreBtn.classList.add("hidden");
  setStatus(
    `${state.books.length} books on the map — live from Open Library. Search any title.`
  );
  animateCamera({ x: WORLD / 2, y: WORLD / 2, scale: 0.75 }, 500);
  history.replaceState(null, "", location.pathname + location.search);
}

async function resolveBook(query) {
  const trimmed = query.trim();
  setStatus(`Searching for “${trimmed}”…`);

  // Try vector catalog search first (instant, local DB)
  if (state.useVectors) {
    try {
      const vectorHits = await searchVectorCatalog(trimmed, 10);
      if (vectorHits?.length) {
        const best = pickBestSearchMatch(trimmed, vectorHits);
        if (best) {
          const book = addBook(best);
          return { book, searchedAs: trimmed };
        }
      }
    } catch (err) {
      console.warn("Vector search failed:", err);
    }
  }

  // Also check local map
  const local = findLocalExactBook(trimmed);
  if (local) return { book: local, searchedAs: trimmed };

  // Fall back to Open Library
  let hits = [];
  try {
    hits = await searchBooks(trimmed, 24);
  } catch (err) {
    if (local) return { book: local, searchedAs: trimmed };
    throw err;
  }

  let book = hits.length ? pickBestSearchMatch(trimmed, hits) : null;

  if (!book) {
    return null;
  }

  book = addBook(book);
  try {
    const { description, subjects } = await fetchWorkDescription(book.open_library_key);
    if (description) book.description = description;
    if (subjects?.length) book.subjects = subjects;
  } catch {
    /* ignore */
  }
  return { book, searchedAs: trimmed };
}

function searchErrorMessage(err) {
  if (err?.name === "AbortError") {
    return "Open Library timed out. Try again or check your connection.";
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return "You appear to be offline.";
  }
  const msg = err?.message || "";
  if (msg.includes("429")) {
    return "Open Library is busy. Wait a moment and try again.";
  }
  return "Search failed. Check your connection, disable ad blockers for openlibrary.org, and retry.";
}

async function onSearchSubmit(e) {
  e.preventDefault();
  if (!state.ready) return;
  const q = els.input.value.trim();
  if (!q) return;

  els.submitBtn.disabled = true;
  try {
    const result = await resolveBook(q);
    if (!result) {
      setStatus(`No match for “${q}”. Try a different title or spelling.`);
      return;
    }
    focusBook(result.book, result.searchedAs);
  } catch (err) {
    setStatus(searchErrorMessage(err));
    console.error(err);
  } finally {
    els.submitBtn.disabled = false;
  }
}

function onWheel(e) {
  if (!state.ready) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  state.camera.scale = Math.min(
    LABEL_MAX_SCALE,
    Math.max(LABEL_MIN_SCALE, state.camera.scale * factor)
  );
  render();
}

function onPointerDown(e) {
  if (
    !state.ready ||
    e.target.closest(
      ".book-label, .shell-header, .detail-panel, .detail-backdrop, .library-panel, .auth-modal, .site-footer"
    )
  )
    return;
  state.dragging = true;
  state.dragLast = { x: e.clientX, y: e.clientY };
  els.wrap.classList.add("dragging");
}

function onPointerMove(e) {
  if (!state.dragging || !state.dragLast) return;
  const dx = e.clientX - state.dragLast.x;
  const dy = e.clientY - state.dragLast.y;
  state.dragLast = { x: e.clientX, y: e.clientY };
  state.camera.x -= dx / state.camera.scale;
  state.camera.y -= dy / state.camera.scale;
  render();
}

function onPointerUp() {
  state.dragging = false;
  state.dragLast = null;
  els.wrap.classList.remove("dragging");
}

function showLoadError(err) {
  hideLoader();
  const hint =
    err?.name === "AbortError"
      ? "Request timed out."
      : err?.message || "Unknown error.";
  setLoaderDetail(
    `${hint} Try Retry, disable ad blockers for openlibrary.org, or check your network.`
  );
  els.loader.classList.remove("hidden");
  els.retryBtn?.classList.remove("hidden");
  setStatus("Could not load books.");
}

async function loadLiveData({ forceRefresh = false } = {}) {
  if (forceRefresh) clearCatalogCache();

  els.retryBtn?.classList.add("hidden");
  els.loader.classList.remove("hidden");
  els.loader.setAttribute("aria-busy", "true");
  setLoaderDetail("Loading book catalog…");

  let books;
  let source = "Open Library";

  // Try vector catalog from Supabase first
  try {
    const vectorsAvailable = await hasVectorCatalog();
    if (vectorsAvailable) {
      books = await loadVectorCatalog({ limit: 500, onProgress: setLoaderDetail });
      source = "vector catalog";
      state.useVectors = true;
    }
  } catch (err) {
    console.warn("Vector catalog not available:", err);
  }

  // Fallback to Open Library live fetch
  if (!books) {
    setLoaderDetail("Connecting to Open Library…");
    try {
      books = await loadLiveCatalog({
        target: 280,
        onProgress: setLoaderDetail,
      });
    } catch (liveErr) {
      console.warn("Live catalog failed, trying fallback", liveErr);
      setLoaderDetail("Open Library slow — loading saved catalog…");
      try {
        books = await loadStaticFallback();
        source = "saved catalog";
      } catch (fallbackErr) {
        showLoadError(liveErr);
        throw liveErr;
      }
    }
  }

  setLoaderDetail("Arranging books on the map…");
  const hasGraph =
    typeof books[0]?.x === "number" &&
    typeof books[0]?.y === "number" &&
    (books[0]?.neighbors?.length ?? 0) >= 8;

  if (!hasGraph) {
    refreshBookGraph(books);
  }

  setBooks(books);
  if (!state.useVectors) saveCatalogCache(books);

  hideLoader();
  exploreAll();
  render();

  const suffix = state.useVectors ? " (embedding-powered)" : "";
  setStatus(`${books.length} books on the map (${source})${suffix}. Search any title.`);

  if (!state.useVectors) {
    enrichBooks(books, { limit: 20, onProgress: setStatus }).catch(() => {});
  }
}

function initLibraryEvents() {
  els.libraryBtn?.addEventListener("click", () => {
    if (!getUser()) {
      openAuthModal();
      return;
    }
    openLibraryPanel();
  });
  els.libraryClose?.addEventListener("click", closeLibraryPanel);

  for (const tab of els.libraryTabs) {
    tab.addEventListener("click", () => {
      for (const t of els.libraryTabs) t.classList.remove("active");
      tab.classList.add("active");
      state.libraryTab = tab.dataset.tab || "read";
      renderLibraryPanel();
    });
  }

  for (const chip of els.discoveryChips) {
    chip.addEventListener("click", () => {
      state.discoveryMode = chip.dataset.discovery || "similar";
      for (const c of els.discoveryChips) {
        c.classList.toggle("active", c === chip);
      }
      updateSimilarHeading();
      const center = state.centerId ? state.byId.get(state.centerId) : null;
      if (center?.neighbors?.length) {
        applyRadialNeighbors(center, center.neighbors);
      }
    });
  }

  els.fromReadsBtn?.addEventListener("click", () => {
    onFromReadsClick().catch((err) => console.warn(err));
  });

  for (const btn of document.querySelectorAll(".library-status-btn")) {
    btn.addEventListener("click", () => {
      const book = state.selectedId ? state.byId.get(state.selectedId) : null;
      if (!book) return;
      handleLibraryAdd(book, btn.dataset.status || "read");
    });
  }

  els.removeLibraryBtn?.addEventListener("click", async () => {
    const book = state.selectedId ? state.byId.get(state.selectedId) : null;
    if (!book || !getUser()) return;
    try {
      await removeFromLibrary(book.id);
      updateDetailLibraryActions(book);
      renderLibraryPanel();
      if (els.libraryActionMsg) els.libraryActionMsg.textContent = "Removed from your list.";
    } catch (err) {
      if (els.libraryActionMsg) els.libraryActionMsg.textContent = err.message;
    }
  });
}

function initEvents() {
  bindAuthElements({
    modal: "auth-modal",
    form: "auth-form",
    email: "auth-email",
    password: "auth-password",
    message: "auth-message",
    modeBtn: "auth-mode-btn",
    submit: "auth-submit",
    userLabel: "user-label",
    signInBtn: "sign-in-btn",
    signOutBtn: "sign-out-btn",
  });

  initLibraryEvents();

  els.form.addEventListener("submit", onSearchSubmit);
  els.detailClose.addEventListener("click", hideDetail);
  els.detailBackdrop.addEventListener("click", hideDetail);
  els.exploreBtn.addEventListener("click", exploreAll);
  els.brandHome.addEventListener("click", (e) => {
    e.preventDefault();
    exploreAll();
  });
  els.retryBtn?.addEventListener("click", () => {
    loadLiveData({ forceRefresh: true }).catch((err) => console.error(err));
  });
  els.wrap.addEventListener("wheel", onWheel, { passive: false });
  els.wrap.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("resize", () => {
    resizeCanvas();
    render();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!els.detail.classList.contains("hidden")) hideDetail();
      else if (state.mode === "search") exploreAll();
    }
  });
}

async function boot() {
  initEvents();
  resizeCanvas();

  await initAuth();
  onAuthChange(async (user) => {
    refreshSignedInChrome();
    if (user) {
      try {
        await loadLibrary();
        renderLibraryPanel();
      } catch (err) {
        console.warn(err);
      }
    } else {
      closeLibraryPanel();
    }
  });
  refreshSignedInChrome();
  if (getUser()) {
    loadLibrary().then(() => renderLibraryPanel()).catch(() => {});
  }

  try {
    await loadLiveData();
    const hash = location.hash.slice(1);
    if (hash) {
      const book = state.byId.get(decodeURIComponent(hash));
      if (book) focusBook(book, book.title);
    }
  } catch (err) {
    console.error(err);
  }
}

boot();
