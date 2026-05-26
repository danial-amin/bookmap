# Bookmap

A [Movie Map](https://www.movie-map.com/)-style site for **books**: type a title and explore similar books on an interactive map. UI matches the warm **Inkwell** design system; **all book data is loaded live** from [Open Library](https://openlibrary.org/) in the browser (no static catalog required to run).

## Quick start

```bash
npm install
npm run dev
```

Open the URL Vite prints. If you’ve populated the Supabase vector catalog, the map loads from there with **real embedding similarity** (sentence-transformers). Otherwise it falls back to Open Library live fetch with browser TF-IDF.

### Populating the vector catalog (recommended)

```bash
pip install -r scripts/requirements.txt
# Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local
python scripts/embed_and_upload.py --limit 500
```

This fetches ~500 books, generates 384-dim embeddings with `all-MiniLM-L6-v2` locally, and uploads to Supabase pgvector. Run once; re-run to grow the catalog. After this, search and “find similar” use **cosine similarity over embeddings** instead of keyword matching.

## Data (live APIs)

| Source | Endpoint | Use |
|--------|----------|-----|
| Popular books | `search.json?q=language:eng&sort=readinglog` | Initial catalog |
| Subject shelves | `/subjects/{fiction,…}.json` | Genre diversity |
| Any search | `search.json?q=…` | Titles you type |
| Descriptions | `/works/OL….json` | Detail panel blurbs |

A 12-hour **localStorage** cache avoids refetching the full catalog every visit.

### Optional offline build

To bake a static `public/data/books.json` (not required for the live site):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/build_books_data.py --limit 250
```

## Accounts & your reading list (Supabase)

Sign in saves books to **your** list (read / reading / want to read). After login you can:

- **Find similar** — same as before, ranked by similarity.
- **Something new** — similar picks but **excludes books you’ve marked as read**.
- **From my reads** — picks a random book from your read list and maps similar titles around it.

### Setup

1. Create a [Supabase](https://supabase.com) project.
2. Run `supabase/migrations/001_bookmap_schema.sql` in the SQL editor.
3. Copy `.env.example` → `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (from **Project Settings → API → Publishable key**, `sb_publishable_…`). The older `VITE_SUPABASE_ANON_KEY` name still works during Supabase’s migration.
4. In Supabase **Authentication → URL configuration**, add redirect URLs:
   - `http://localhost:5173/bookmap/auth/callback.html` (or your Vite dev path)
   - `https://danialamin.com/bookmap/auth/callback.html` (production)
5. `npm run dev` — sign up / sign in from the header.

Without Supabase keys the map still works; library features stay hidden until configured.

## Deploy

### GitHub Pages (static)

```bash
npm run build
# push dist to gh-pages, or use the Actions workflow on danial-amin/bookmap
```

Build with Supabase env vars set in CI or locally so the bundle includes your publishable key (safe for the browser with RLS; never put secret/service keys in the frontend).

### Railway (optional Node host)

```bash
npm install
npm run build
npm start
```

Set `PORT` on Railway. The server serves `dist/` and `/health`. Auth still goes through Supabase in the browser.

Account: **danial-amin** (see `.cursor/rules/github-danial-amin.mdc` in the parent repo).

## License

MIT — book metadata © Open Library contributors.
