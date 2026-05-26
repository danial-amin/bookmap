#!/usr/bin/env python3
"""
Fetch books from Open Library, generate embeddings with sentence-transformers,
and upload to Supabase pgvector.

Usage:
  pip install -r scripts/requirements.txt
  cp .env.example .env.local   # fill in Supabase credentials
  python scripts/embed_and_upload.py --limit 500

Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in environment or .env.local.
Uses the all-MiniLM-L6-v2 model (384-dim, ~80MB download on first run).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path

import numpy as np
import requests
from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer
from supabase import create_client

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "scripts" / ".cache" / "open_library.json"

SEARCH_URL = "https://openlibrary.org/search.json"
SUBJECT_URL = "https://openlibrary.org/subjects/{subject}.json"
WORK_URL = "https://openlibrary.org{key}.json"

SUBJECT_SHELVES = [
    "fiction",
    "science_fiction",
    "fantasy",
    "mystery",
    "romance",
    "horror",
    "thriller",
    "biography",
    "history",
    "philosophy",
    "poetry",
    "young_adult",
    "classics",
    "psychology",
    "science",
    "adventure",
    "crime",
    "humor",
    "travel",
    "memoir",
    "economics",
    "self_help",
    "art",
    "music",
    "drama",
    "politics",
    "religion",
    "technology",
    "cooking",
    "sports",
    "nature",
    "war",
    "dystopian",
    "graphic_novels",
    "short_stories",
    "essays",
]

EXTRA_SEARCHES = [
    "pulitzer prize fiction",
    "booker prize winner",
    "nobel literature",
    "new york times bestseller",
    "national book award",
    "hugo award winner",
    "nebula award",
    "agatha christie",
    "stephen king",
    "haruki murakami",
    "toni morrison",
    "gabriel garcia marquez",
    "ursula le guin",
    "philip k dick",
    "margaret atwood",
    "neil gaiman",
    "terry pratchett",
    "isaac asimov",
    "tolkien",
    "dostoevsky",
    "kafka",
    "virginia woolf",
    "james baldwin",
    "octavia butler",
    "chimamanda ngozi adichie",
    "debut novel 2020",
    "debut novel 2021",
    "debut novel 2022",
    "debut novel 2023",
    "best fiction 2024",
    "literary fiction",
    "magical realism",
    "historical fiction",
    "coming of age novel",
    "existentialism",
    "cyberpunk",
    "space opera",
    "cozy mystery",
    "gothic fiction",
    "southern gothic",
    "afrofuturism",
    "japanese literature",
    "latin american literature",
    "russian literature",
    "indian literature english",
    "african literature",
    "korean fiction",
    "scandinavian noir",
    "philosophical fiction",
    "post apocalyptic",
    "cli fi climate fiction",
]

SKIP_TITLE = re.compile(
    r"(?i)\b("
    r"study guide|sparknotes|cliffsnotes|summary of|analysis of|"
    r"workbook|teacher'?s guide|test prep|exam prep|"
    r"poster book|colouring book|coloring book|"
    r"^\s*notes on\b"
    r")\b"
)

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
BATCH_SIZE = 64


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
    return True


def doc_from_search(doc: dict, source: str) -> dict | None:
    if not is_usable_doc(doc):
        return None
    work_key = normalize_work_key(doc.get("key", ""))
    if not work_key:
        return None
    author = (doc.get("author_name") or ["Unknown"])[0]
    subjects = [s for s in (doc.get("subject") or []) if isinstance(s, str)][:20]
    sentences = doc.get("first_sentence") or []
    if isinstance(sentences, list):
        snippet = " ".join(s for s in sentences if isinstance(s, str))[:800]
    else:
        snippet = str(sentences)[:800]

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
    }


def doc_from_subject_work(work: dict, subject: str) -> dict | None:
    title = (work.get("title") or "").strip()
    if not title or SKIP_TITLE.search(title):
        return None
    work_key = normalize_work_key(work.get("key", ""))
    if not work_key:
        return None
    author = "Unknown"
    if work.get("authors") and work["authors"][0].get("name"):
        author = work["authors"][0]["name"]
    subjects = [s for s in (work.get("subject") or []) if isinstance(s, str)][:20]

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
        "source": f"subject:{subject}",
    }


def fetch_readinglog(session: requests.Session, limit: int) -> list[dict]:
    books = []
    for offset in range(0, limit * 3, 100):
        if len(books) >= limit:
            break
        try:
            resp = session.get(
                SEARCH_URL,
                params={
                    "q": "language:eng",
                    "sort": "readinglog",
                    "limit": 100,
                    "offset": offset,
                    "fields": "key,title,author_name,first_publish_year,cover_i,subject,first_sentence",
                },
                timeout=20,
            )
            resp.raise_for_status()
            docs = resp.json().get("docs", [])
            for doc in docs:
                b = doc_from_search(doc, "readinglog")
                if b:
                    books.append(b)
        except Exception as e:
            print(f"  readinglog offset={offset} failed: {e}")
            break
        time.sleep(0.3)
    return books


def fetch_subjects(session: requests.Session, limit_per: int) -> list[dict]:
    books = []
    for subject in SUBJECT_SHELVES:
        try:
            resp = session.get(
                SUBJECT_URL.format(subject=subject),
                params={"limit": limit_per},
                timeout=15,
            )
            resp.raise_for_status()
            works = resp.json().get("works", [])
            for w in works:
                b = doc_from_subject_work(w, subject)
                if b:
                    books.append(b)
            print(f"  subject '{subject}': {len(works)} works")
        except Exception as e:
            print(f"  subject '{subject}' failed: {e}")
        time.sleep(0.3)
    return books


def fetch_extra_searches(session: requests.Session, limit_per: int = 30) -> list[dict]:
    """Search for award winners, popular authors, subgenres, world literature."""
    books = []
    for query in EXTRA_SEARCHES:
        try:
            resp = session.get(
                SEARCH_URL,
                params={
                    "q": query,
                    "limit": limit_per,
                    "fields": "key,title,author_name,first_publish_year,cover_i,subject,first_sentence",
                },
                timeout=15,
            )
            resp.raise_for_status()
            docs = resp.json().get("docs", [])
            count = 0
            for doc in docs:
                b = doc_from_search(doc, f"search:{query}")
                if b:
                    books.append(b)
                    count += 1
            print(f"  search '{query}': {count} books")
        except Exception as e:
            print(f"  search '{query}' failed: {e}")
        time.sleep(0.3)
    return books


def enrich_with_descriptions(
    session: requests.Session, books: list[dict], cache: dict, limit: int = 300
) -> None:
    """Fetch work descriptions from Open Library (cached)."""
    need = [b for b in books if not b["description"] and b["open_library_key"]][:limit]
    for i, book in enumerate(need, 1):
        key = book["open_library_key"]
        if key in cache:
            data = cache[key]
        else:
            try:
                resp = session.get(WORK_URL.format(key=key), timeout=10)
                resp.raise_for_status()
                data = resp.json()
                cache[key] = data
            except Exception:
                data = {}
            time.sleep(0.15)

        desc = data.get("description", "")
        if isinstance(desc, dict):
            desc = desc.get("value", "")
        book["description"] = (desc or "")[:1500]

        subjects = data.get("subjects") or []
        if subjects:
            book["subjects"] = [s for s in subjects if isinstance(s, str)][:20]

        if i % 50 == 0 or i == len(need):
            print(f"  enriched {i}/{len(need)} descriptions")
    save_cache(cache)


def build_embedding_text(book: dict) -> str:
    """Combine fields into a single string for the embedding model."""
    parts = [
        book["title"],
        f"by {book['author']}",
    ]
    if book.get("subjects"):
        parts.append("Subjects: " + ", ".join(book["subjects"][:12]))
    if book.get("description"):
        parts.append(book["description"][:600])
    elif book.get("snippet"):
        parts.append(book["snippet"][:400])
    return " ".join(parts)


def deduplicate(books: list[dict]) -> list[dict]:
    seen = {}
    for b in books:
        if b["id"] not in seen:
            seen[b["id"]] = b
        else:
            existing = seen[b["id"]]
            if len(b.get("subjects", [])) > len(existing.get("subjects", [])):
                seen[b["id"]] = b
    return list(seen.values())


def generate_embeddings(books: list[dict], model: SentenceTransformer) -> np.ndarray:
    texts = [build_embedding_text(b) for b in books]
    print(f"Generating embeddings for {len(texts)} books...")
    embeddings = model.encode(texts, batch_size=BATCH_SIZE, show_progress_bar=True)
    return embeddings


def upload_to_supabase(books: list[dict], embeddings: np.ndarray, supabase_url: str, supabase_key: str) -> None:
    supabase = create_client(supabase_url, supabase_key)

    print(f"Uploading {len(books)} books to Supabase...")
    batch_size = 50
    uploaded = 0

    for i in range(0, len(books), batch_size):
        batch = books[i : i + batch_size]
        batch_embeddings = embeddings[i : i + batch_size]
        rows = []
        for book, emb in zip(batch, batch_embeddings):
            rows.append(
                {
                    "id": book["id"],
                    "open_library_key": book["open_library_key"],
                    "title": book["title"],
                    "author": book["author"],
                    "year": book.get("year"),
                    "cover_i": book.get("cover_i"),
                    "subjects": book.get("subjects", []),
                    "description": book.get("description", ""),
                    "snippet": book.get("snippet", ""),
                    "embedding": emb.tolist(),
                }
            )
        supabase.table("books").upsert(rows, on_conflict="id").execute()
        uploaded += len(rows)
        if uploaded % 100 == 0 or uploaded == len(books):
            print(f"  uploaded {uploaded}/{len(books)}")

    print(f"Done. {uploaded} books in Supabase with embeddings.")


def fetch_existing_ids(supabase_url: str, supabase_key: str) -> set[str]:
    """Get IDs of books already in Supabase so we can skip them."""
    supabase = create_client(supabase_url, supabase_key)
    ids = set()
    offset = 0
    while True:
        resp = supabase.table("books").select("id").range(offset, offset + 999).execute()
        batch = resp.data or []
        if not batch:
            break
        for row in batch:
            ids.add(row["id"])
        offset += len(batch)
        if len(batch) < 1000:
            break
    return ids


def parse_args():
    p = argparse.ArgumentParser(description="Embed books and upload to Supabase pgvector")
    p.add_argument("--limit", type=int, default=500, help="Target number of books")
    p.add_argument("--skip-enrich", action="store_true", help="Skip fetching descriptions")
    p.add_argument("--dry-run", action="store_true", help="Generate embeddings but don't upload")
    p.add_argument("--force", action="store_true", help="Re-embed all books even if already in DB")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    for env_file in [ROOT / ".env.local", ROOT / ".env"]:
        if env_file.exists():
            load_dotenv(env_file)
            break

    supabase_url = os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")

    if not args.dry_run and (not supabase_url or not supabase_key):
        raise SystemExit(
            "Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local\n"
            "(Service key from Supabase → Project Settings → API → service_role secret)"
        )

    session = requests.Session()
    session.headers.update({"User-Agent": "bookmap/0.3 (embedding pipeline)"})
    cache = load_cache()

    # Collect books
    print(f"Fetching up to {args.limit} books from Open Library...")
    readinglog = fetch_readinglog(session, min(args.limit, 600))
    print(f"  readinglog: {len(readinglog)} books")

    subject_books = fetch_subjects(session, limit_per=80)
    print(f"  subjects: {len(subject_books)} books")

    extra = fetch_extra_searches(session, limit_per=30)
    print(f"  extra searches: {len(extra)} books")

    all_books = deduplicate(readinglog + subject_books + extra)
    all_books = all_books[: args.limit]
    print(f"Total unique: {len(all_books)} books")

    # Skip books already in Supabase
    if not args.dry_run and not args.force:
        print("Checking which books are already in Supabase...")
        existing = fetch_existing_ids(supabase_url, supabase_key)
        before = len(all_books)
        all_books = [b for b in all_books if b["id"] not in existing]
        skipped = before - len(all_books)
        if skipped:
            print(f"  Skipping {skipped} books already in DB. {len(all_books)} new to process.")
        if not all_books:
            print("Nothing new to embed. Use --force to re-embed everything.")
            return

    # Enrich with descriptions
    if not args.skip_enrich:
        print("Enriching with descriptions...")
        enrich_with_descriptions(session, all_books, cache, limit=len(all_books))

    # Generate embeddings
    print(f"Loading model: {MODEL_NAME}")
    model = SentenceTransformer(MODEL_NAME)
    embeddings = generate_embeddings(all_books, model)
    print(f"Embeddings shape: {embeddings.shape}")

    if args.dry_run:
        out = ROOT / "scripts" / ".cache" / "embeddings_preview.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        preview = [
            {"id": b["id"], "title": b["title"], "author": b["author"]}
            for b in all_books[:20]
        ]
        out.write_text(json.dumps(preview, indent=2))
        print(f"Dry run. Preview: {out}")
        return

    # Upload
    upload_to_supabase(all_books, embeddings, supabase_url, supabase_key)
    print("\nPipeline complete.")


if __name__ == "__main__":
    main()
