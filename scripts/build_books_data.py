#!/usr/bin/env python3
"""
Build books.json from Open Library — no manual title list.

Sources (see --source):
  readinglog  — English works ranked by how often they appear on reading lists
  subjects    — Popular works within broad subject areas (fiction, mystery, …)
  mixed       — both (default)
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import numpy as np
import requests
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.neighbors import NearestNeighbors

try:
    import umap
except ImportError as exc:
    raise SystemExit("Install deps: pip install -r scripts/requirements.txt") from exc

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "scripts" / ".cache" / "open_library.json"
OUT = ROOT / "public" / "data" / "books.json"
SEARCH_URL = "https://openlibrary.org/search.json"
SUBJECT_URL = "https://openlibrary.org/subjects/{subject}.json"
WORK_URL = "https://openlibrary.org{key}.json"

# Broad shelves for variety (not individual book titles).
SUBJECT_SHELVES = [
    "fiction",
    "science_fiction",
    "fantasy",
    "mystery",
    "romance",
    "horror",
    "biography",
    "history",
    "poetry",
    "young_adult",
    "children",
    "classics",
]

SKIP_TITLE = re.compile(
    r"(?i)\b("
    r"study guide|sparknotes|cliffsnotes|summary of|analysis of|"
    r"workbook|teacher'?s guide|test prep|exam prep|"
    r"poster book|colouring book|coloring book|"
    r"^\s*notes on\b"
    r")\b"
)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def load_cache() -> dict:
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    return {}


def save_cache(cache: dict) -> None:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, indent=2))


def normalize_work_key(key: str) -> str | None:
    if not key:
        return None
    if key.startswith("/works/"):
        return key
    if key.startswith("OL") and key.endswith("W"):
        return f"/works/{key}"
    return None


def is_usable_doc(doc: dict) -> bool:
    title = (doc.get("title") or "").strip()
    if not title or SKIP_TITLE.search(title):
        return False
    if not doc.get("author_name"):
        return False
    return True


def doc_from_search_hit(doc: dict, source: str) -> dict:
    work_key = normalize_work_key(doc.get("key", ""))
    author = doc["author_name"][0]
    subjects = doc.get("subject") or []
    if isinstance(subjects, list):
        subjects = [s for s in subjects if isinstance(s, str)][:14]
    sentences = doc.get("first_sentence") or []
    if isinstance(sentences, list):
        snippet = " ".join(s for s in sentences if isinstance(s, str))[:600]
    else:
        snippet = str(sentences)[:600]

    return {
        "id": slug(f"{doc['title']}-{author}"),
        "title": doc["title"],
        "author": author,
        "year": doc.get("first_publish_year"),
        "cover_i": doc.get("cover_i"),
        "open_library_key": work_key,
        "subjects": subjects,
        "description": "",
        "snippet": snippet,
        "source": source,
        "ratings_count": doc.get("ratings_count"),
        "edition_count": doc.get("edition_count"),
        "search_text": "",
    }


def doc_from_subject_work(work: dict, subject: str) -> dict | None:
    title = (work.get("title") or "").strip()
    if not title or SKIP_TITLE.search(title):
        return None
    work_key = normalize_work_key(work.get("key", ""))
    if not work_key:
        return None

    authors = work.get("authors") or []
    author = "Unknown"
    if authors and isinstance(authors[0], dict):
        author = authors[0].get("name") or author
    elif work.get("author_name"):
        author = work["author_name"][0]

    subjects = work.get("subject") or []
    if isinstance(subjects, list):
        subjects = [s for s in subjects if isinstance(s, str)][:14]

    return {
        "id": slug(f"{title}-{author}"),
        "title": title,
        "author": author,
        "year": None,
        "cover_i": work.get("cover_id"),
        "open_library_key": work_key,
        "subjects": subjects,
        "description": "",
        "snippet": "",
        "source": f"openlibrary:subject:{subject}",
        "ratings_count": None,
        "edition_count": work.get("edition_count"),
        "search_text": "",
    }


def fetch_readinglog_page(
    session: requests.Session, offset: int, page_size: int
) -> list[dict]:
    resp = session.get(
        SEARCH_URL,
        params={
            "q": "language:eng",
            "sort": "readinglog",
            "limit": page_size,
            "offset": offset,
            "fields": "key,title,author_name,first_publish_year,cover_i,subject,first_sentence,ratings_count,edition_count",
        },
        timeout=30,
    )
    resp.raise_for_status()
    return [d for d in resp.json().get("docs", []) if is_usable_doc(d)]


def fetch_subject_page(
    session: requests.Session, subject: str, offset: int, page_size: int
) -> list[dict]:
    resp = session.get(
        SUBJECT_URL.format(subject=subject),
        params={"limit": page_size, "offset": offset},
        timeout=30,
    )
    resp.raise_for_status()
    works = resp.json().get("works", [])
    out = []
    for w in works:
        rec = doc_from_subject_work(w, subject)
        if rec:
            out.append(rec)
    return out


def enrich_with_work(
    session: requests.Session, record: dict, cache: dict
) -> dict:
    work_key = record.get("open_library_key")
    if not work_key:
        return record

    if work_key in cache:
        cached = cache[work_key]
        if cached:
            record["description"] = cached.get("description", "")
            if cached.get("subjects"):
                record["subjects"] = cached["subjects"]
        return record

    try:
        resp = session.get(WORK_URL.format(key=work_key), timeout=20)
        resp.raise_for_status()
        work = resp.json()
    except requests.RequestException:
        cache[work_key] = None
        return record

    description = work.get("description")
    if isinstance(description, dict):
        description = description.get("value", "")
    description = (description or "")[:1200]

    subjects = work.get("subjects") or record.get("subjects") or []
    if isinstance(subjects, list):
        subjects = [s for s in subjects if isinstance(s, str)][:14]

    cache[work_key] = {"description": description, "subjects": subjects}
    record["description"] = description
    record["subjects"] = subjects
    time.sleep(0.12)
    return record


def build_search_text(record: dict) -> str:
    return " ".join(
        [
            record["title"],
            record["author"],
            " ".join(record.get("subjects") or []),
            record.get("snippet") or "",
            record.get("description") or "",
        ]
    ).lower()


def collect_candidates(
    session: requests.Session,
    limit: int,
    source: str,
) -> list[dict]:
    """Gather unique book records from Open Library APIs."""
    seen_ids: set[str] = set()
    books: list[dict] = []

    def add_batch(raw_docs: list[dict], label: str) -> None:
        nonlocal books
        for doc in raw_docs:
            if len(books) >= limit:
                return
            if isinstance(doc, dict) and "title" in doc and "author_name" in doc:
                rec = doc_from_search_hit(doc, f"openlibrary:{label}")
            else:
                rec = doc
            if not rec or rec["id"] in seen_ids:
                continue
            seen_ids.add(rec["id"])
            books.append(rec)

    page_size = min(100, limit)

    if source in ("readinglog", "mixed"):
        print("Source: Open Library search (language:eng, sort=readinglog)")
        offset = 0
        while len(books) < limit:
            need = limit - len(books)
            hits = fetch_readinglog_page(session, offset, min(page_size, need + 20))
            if not hits:
                break
            before = len(books)
            add_batch(hits, "readinglog")
            print(f"  readinglog offset {offset}: +{len(books) - before} (total {len(books)})")
            offset += page_size
            time.sleep(0.25)
            if len(hits) < page_size:
                break

    if source in ("subjects", "mixed"):
        print("Source: Open Library subject shelves")
        per_subject = max(30, limit // len(SUBJECT_SHELVES))
        for subject in SUBJECT_SHELVES:
            if len(books) >= limit:
                break
            offset = 0
            gathered = 0
            while gathered < per_subject and len(books) < limit:
                hits = fetch_subject_page(session, subject, offset, min(50, per_subject - gathered))
                if not hits:
                    break
                before = len(books)
                add_batch(hits, f"subject:{subject}")
                gathered += len(books) - before
                print(f"  subject {subject} offset {offset}: total {len(books)}")
                offset += 50
                time.sleep(0.25)
                if len(hits) < 50:
                    break

    return books[:limit]


def layout_umap(vectors: np.ndarray) -> np.ndarray:
    n = vectors.shape[0]
    if n < 8:
        return np.random.default_rng(42).uniform(0, 1, size=(n, 2))

    n_neighbors = min(15, n - 1)
    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=n_neighbors,
        min_dist=0.35,
        metric="cosine",
        random_state=42,
    )
    coords = reducer.fit_transform(vectors)
    coords -= coords.min(axis=0)
    span = coords.max(axis=0) - coords.min(axis=0)
    span[span == 0] = 1
    return coords / span


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build bookmap data from Open Library.")
    p.add_argument(
        "--limit",
        type=int,
        default=250,
        help="How many books to include (default: 250)",
    )
    p.add_argument(
        "--source",
        choices=("mixed", "readinglog", "subjects"),
        default="mixed",
        help="Where to discover books (default: mixed)",
    )
    p.add_argument(
        "--skip-enrich",
        action="store_true",
        help="Skip per-work API calls (faster; weaker similarity)",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()
    cache = load_cache()
    session = requests.Session()
    session.headers.update({"User-Agent": "bookmap/0.2 (https://openlibrary.org)"})

    print(f"Collecting up to {args.limit} books from Open Library ({args.source})…")
    books = collect_candidates(session, args.limit, args.source)

    if len(books) < 10:
        raise SystemExit(f"Need at least 10 books, got {len(books)}")

    if not args.skip_enrich:
        print(f"Enriching {len(books)} works with descriptions…")
        for i, book in enumerate(books, 1):
            enrich_with_work(session, book, cache)
            if i % 25 == 0 or i == len(books):
                print(f"  enriched {i}/{len(books)}")
        save_cache(cache)

    for book in books:
        book["search_text"] = build_search_text(book)

    texts = [b["search_text"] for b in books]
    vectorizer = TfidfVectorizer(max_features=8000, stop_words="english", ngram_range=(1, 2))
    matrix = vectorizer.fit_transform(texts)
    vectors = matrix.toarray().astype(np.float32)
    coords = layout_umap(vectors)

    nn = NearestNeighbors(n_neighbors=min(51, len(books)), metric="cosine")
    nn.fit(vectors)
    distances, indices = nn.kneighbors(vectors)

    for i, book in enumerate(books):
        book["x"] = round(float(coords[i, 0]), 5)
        book["y"] = round(float(coords[i, 1]), 5)
        neighbors = []
        for dist, j in zip(distances[i], indices[i]):
            if j == i:
                continue
            other = books[j]
            neighbors.append({"id": other["id"], "similarity": round(float(1 - dist), 4)})
            if len(neighbors) >= 48:
                break
        book["neighbors"] = neighbors
        for drop in ("search_text", "snippet"):
            book.pop(drop, None)

    payload = {
        "version": 2,
        "generated_at": time.strftime("%Y-%m-%d"),
        "data_source": "openlibrary.org",
        "discovery": args.source,
        "count": len(books),
        "books": books,
        "title_index": {b["title"].lower(): b["id"] for b in books},
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2))
    print(f"\nWrote {len(books)} books → {OUT}")


if __name__ == "__main__":
    main()
