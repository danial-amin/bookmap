const WORLD = 1000;
const LABEL_MIN_SCALE = 0.35;
const LABEL_MAX_SCALE = 2.2;

const state = {
  books: [],
  byId: new Map(),
  camera: { x: WORLD / 2, y: WORLD / 2, scale: 0.85 },
  targetCamera: null,
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
};

const ctx = els.canvas.getContext("2d");
let labelNodes = new Map();

function setStatus(msg) {
  els.status.textContent = msg || "";
}

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findBook(query) {
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

function screenToWorld(sx, sy) {
  const rect = els.wrap.getBoundingClientRect();
  const { x: cx, y: cy, scale } = state.camera;
  return {
    x: cx + (sx - rect.width / 2) / scale,
    y: cy + (sy - rect.height / 2) / scale,
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
  grad.addColorStop(0, "rgba(126, 184, 255, 0.06)");
  grad.addColorStop(1, "rgba(15, 20, 25, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, rect.width, rect.height);

  if (state.mode === "search" && state.centerId) {
    const center = worldToScreen(WORLD / 2, WORLD / 2);
    for (let r = 80; r <= 360; r += 70) {
      ctx.beginPath();
      ctx.arc(center.x, center.y, r * state.camera.scale * 0.45, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(126, 184, 255, 0.07)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function updateLabels() {
  const layout = layoutForMode(state.centerId ? state.byId.get(state.centerId) : null);
  const rect = els.wrap.getBoundingClientRect();
  const visible = new Set();

  const minFont = 10;
  const maxShown = state.mode === "search" ? 80 : 120;

  const ranked = layout
    .map((item) => {
      const screen = worldToScreen(item.x, item.y);
      const inView =
        screen.x > -80 &&
        screen.x < rect.width + 80 &&
        screen.y > -20 &&
        screen.y < rect.height + 20;
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
        focusBook(item.book, true);
      });
      labelNodes.set(item.id, node);
      els.labels.appendChild(node);
    }

    const scale = state.camera.scale;
    const fontSize = Math.min(
      16,
      Math.max(minFont, (item.isCenter ? 14 : 11) * Math.sqrt(scale))
    );
    node.style.left = `${item.screen.x}px`;
    node.style.top = `${item.screen.y}px`;
    node.style.fontSize = `${fontSize}px`;
    node.classList.toggle("center", item.isCenter);
    node.classList.toggle("near", item.isNear && !item.isCenter);
    node.classList.toggle("focused", item.id === state.selectedId);
    node.style.opacity =
      state.mode === "search" && !item.isCenter && !item.isNear ? "0.35" : "1";
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

function focusBook(book, fromClick = false) {
  state.centerId = book.id;
  state.neighborIds = new Set((book.neighbors || []).map((n) => n.id));
  state.mode = "search";
  state.selectedId = book.id;
  showDetail(book);
  setStatus(
    `Showing books similar to “${book.title}”. Closer titles are more alike.`
  );
  els.input.value = book.title;

  const target = {
    x: WORLD / 2,
    y: WORLD / 2,
    scale: Math.min(LABEL_MAX_SCALE, Math.max(0.9, 1.15)),
  };
  animateCamera(target);
  history.replaceState(null, "", `#${encodeURIComponent(book.id)}`);
}

function showDetail(book) {
  els.detail.classList.remove("hidden");
  els.detailTitle.textContent = book.title;
  els.detailAuthor.textContent = [book.author, book.year].filter(Boolean).join(" · ");
  els.detailBlurb.textContent = book.description || "No description available.";
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
  setStatus(
    `${state.books.length} books on the map. Search to zoom into similar titles.`
  );
  animateCamera({ x: WORLD / 2, y: WORLD / 2, scale: 0.75 }, 500);
  history.replaceState(null, "", " ");
}

function onSearchSubmit(e) {
  e.preventDefault();
  const book = findBook(els.input.value);
  if (!book) {
    setStatus(`No match for “${els.input.value.trim()}”. Try another title.`);
    return;
  }
  focusBook(book);
}

function onWheel(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
  const next = state.camera.scale * factor;
  state.camera.scale = Math.min(LABEL_MAX_SCALE, Math.max(LABEL_MIN_SCALE, next));
  render();
}

function onPointerDown(e) {
  if (e.target.closest(".book-label, .header, .detail")) return;
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

async function loadData() {
  setStatus("Loading book map…");
  const res = await fetch("./data/books.json");
  if (!res.ok) throw new Error("Could not load books.json");
  const data = await res.json();
  state.books = data.books;
  state.byId = new Map(data.books.map((b) => [b.id, b]));
  const src = data.data_source ? ` from ${data.data_source}` : "";
  setStatus(`${data.count} books loaded${src}. Search to explore similar titles.`);
}

function initEvents() {
  els.form.addEventListener("submit", onSearchSubmit);
  els.detailClose.addEventListener("click", hideDetail);
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
    await loadData();
    exploreAll();

    const hash = location.hash.slice(1);
    if (hash) {
      const book = state.byId.get(decodeURIComponent(hash));
      if (book) focusBook(book);
    }
  } catch (err) {
    setStatus(
      "Could not load the map. Run: python scripts/build_books_data.py then npm run dev"
    );
    console.error(err);
  }
  render();
}

boot();
