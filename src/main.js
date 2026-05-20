import {
  loadLiveCatalog,
  enrichBooks,
  searchBooks,
  fetchWorkDescription,
  saveCatalogCache,
} from "./api.js";
import { refreshBookGraph, neighborsForBook } from "./similarity.js";

const WORLD = 1000;
const LABEL_MIN_SCALE = 0.35;
const LABEL_MAX_SCALE = 2.2;

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
};

const els = {
  canvas: document.getElementById("map-canvas"),
  labels: document.getElementById("map-labels"),
  wrap: document.getElementById("map-wrap"),
  form: document.getElementById("search-form"),
  input: document.getElementById("search-input"),
  status: document.getElementById("status"),
  detail: document.getElementById("detail"),
  detailTitle: document.getElementById("detail-title"),
  detailAuthor: document.getElementById("detail-author"),
  detailBlurb: document.getElementById("detail-blurb"),
  detailLink: document.getElementById("detail-link"),
  detailClose: document.getElementById("detail-close"),
  loader: document.getElementById("loader"),
  loaderDetail: document.getElementById("loader-detail"),
  exploreBtn: document.getElementById("explore-btn"),
  brandHome: document.getElementById("brand-home"),
  submitBtn: document.querySelector(".btn-primary"),
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

function findLocalBook(query) {
  const q = normalize(query);
  if (!q) return null;

  const exact = state.books.find((b) => normalize(b.title) === q);
  if (exact) return exact;

  const contains = state.books.filter((b) => normalize(b.title).includes(q));
  if (contains.length === 1) return contains[0];
  if (contains.length > 1) {
    contains.sort((a, b) => a.title.length - b.title.length);
    return contains[0];
  }

  let best = null;
  let bestScore = 0;
  for (const book of state.books) {
    const t = normalize(book.title);
    const words = q.split(" ");
    const hits = words.filter((w) => w.length > 2 && t.includes(w)).length;
    const score = hits / words.length;
    if (score > bestScore) {
      bestScore = score;
      best = book;
    }
  }
  return bestScore >= 0.5 ? best : null;
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

  for (const n of book.neighbors || []) {
    const other = state.byId.get(n.id);
    if (!other) continue;
    const radius = (1 - n.similarity) * 380 + 55;
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
    for (let r = 80; r <= 360; r += 70) {
      ctx.beginPath();
      ctx.arc(center.x, center.y, r * state.camera.scale * 0.45, 0, Math.PI * 2);
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

function focusBook(book) {
  if (!book.neighbors?.length) {
    book.neighbors = neighborsForBook(book, state.books);
  }
  state.centerId = book.id;
  state.neighborIds = new Set((book.neighbors || []).map((n) => n.id));
  state.mode = "search";
  state.selectedId = book.id;
  els.exploreBtn.classList.remove("hidden");
  showDetail(book);
  ensureDescription(book);
  setStatus(
    `Books similar to “${book.title}” — closer titles are more alike.`
  );
  els.input.value = book.title;

  animateCamera({
    x: WORLD / 2,
    y: WORLD / 2,
    scale: Math.min(LABEL_MAX_SCALE, Math.max(0.9, 1.15)),
  });
  history.replaceState(null, "", `#${encodeURIComponent(book.id)}`);
}

function showDetail(book) {
  els.detail.classList.remove("hidden");
  els.detailTitle.textContent = book.title;
  els.detailAuthor.textContent = [book.author, book.year].filter(Boolean).join(" · ");
  els.detailBlurb.textContent =
    book.description ||
    book.snippet ||
    "Fetching details from Open Library…";
  const key = book.open_library_key || "";
  els.detailLink.href = key
    ? `https://openlibrary.org${key}`
    : `https://openlibrary.org/search?q=${encodeURIComponent(book.title)}`;
}

function hideDetail() {
  els.detail.classList.add("hidden");
  state.selectedId = null;
}

function exploreAll() {
  state.mode = "explore";
  state.centerId = null;
  state.neighborIds.clear();
  hideDetail();
  els.exploreBtn.classList.add("hidden");
  setStatus(
    `${state.books.length} books on the map — live from Open Library. Search any title.`
  );
  animateCamera({ x: WORLD / 2, y: WORLD / 2, scale: 0.75 }, 500);
  history.replaceState(null, "", location.pathname + location.search);
}

async function resolveBook(query) {
  const local = findLocalBook(query);
  if (local) return local;

  setStatus(`Searching Open Library for “${query.trim()}”…`);
  const hits = await searchBooks(query, 8);
  if (!hits.length) return null;

  const q = normalize(query);
  const exact = hits.find((h) => normalize(h.title) === q) || hits[0];
  const book = addBook(exact);
  try {
    const { description, subjects } = await fetchWorkDescription(book.open_library_key);
    if (description) book.description = description;
    if (subjects?.length) book.subjects = subjects;
  } catch {
    /* ignore */
  }
  return book;
}

async function onSearchSubmit(e) {
  e.preventDefault();
  if (!state.ready) return;
  const q = els.input.value.trim();
  if (!q) return;

  els.submitBtn.disabled = true;
  try {
    const book = await resolveBook(q);
    if (!book) {
      setStatus(`No match for “${q}”. Try a different title or spelling.`);
      return;
    }
    focusBook(book);
  } catch (err) {
    setStatus("Search failed. Check your connection and try again.");
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
  if (!state.ready || e.target.closest(".book-label, .shell-header, .detail, .site-footer"))
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

async function loadLiveData() {
  const books = await loadLiveCatalog({
    target: 220,
    onProgress: setLoaderDetail,
  });

  setLoaderDetail("Arranging books on the map…");
  if (!books[0]?.x || !books[0]?.neighbors?.length) {
    refreshBookGraph(books);
  }
  setBooks(books);

  hideLoader();
  exploreAll();
  render();

  enrichBooks(books, { limit: 60, onProgress: setStatus }).then(() => {
    refreshBookGraph(books);
    saveCatalogCache(books);
    setStatus(
      `${books.length} books on the map — live from Open Library. Search any title.`
    );
    render();
  });
}

function initEvents() {
  els.form.addEventListener("submit", onSearchSubmit);
  els.detailClose.addEventListener("click", hideDetail);
  els.exploreBtn.addEventListener("click", exploreAll);
  els.brandHome.addEventListener("click", (e) => {
    e.preventDefault();
    exploreAll();
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
  try {
    await loadLiveData();
    const hash = location.hash.slice(1);
    if (hash) {
      const book = state.byId.get(decodeURIComponent(hash));
      if (book) focusBook(book);
    }
  } catch (err) {
    hideLoader();
    setStatus(
      "Could not load books from Open Library. Check your connection and refresh."
    );
    console.error(err);
  }
}

boot();
