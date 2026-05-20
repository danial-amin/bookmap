# Bookmap

A [Movie Map](https://www.movie-map.com/)-style site for **books**: type a title and explore similar books on an interactive map. Closer labels mean more similar.

All catalog data comes from **[Open Library](https://openlibrary.org/)** — no hand-maintained title list.

## Quick start

```bash
# 1. Build the map (fetches popular English books from Open Library)
python3 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/build_books_data.py --limit 250

# 2. Run the site
npm install
npm run dev
```

### Data sources (`--source`)

| Value | What it pulls |
|--------|----------------|
| `mixed` (default) | Reading-list popularity **plus** works from subject shelves (fiction, sci‑fi, mystery, …) |
| `readinglog` | `search.json?q=language:eng&sort=readinglog` — books people actually log on Open Library |
| `subjects` | `/subjects/{shelf}.json` — top works per broad subject |

Options:

```bash
python scripts/build_books_data.py --limit 400 --source readinglog
python scripts/build_books_data.py --limit 200 --skip-enrich   # faster, no per-work descriptions
```

Results are cached in `scripts/.cache/open_library.json` so re-runs are quicker.

## How it works

1. **Discover** — paginate Open Library APIs until `--limit` unique works are collected (filters out study guides / summaries).
2. **Enrich** — optional work-level fetch for descriptions and subjects.
3. **Layout** — TF‑IDF on metadata → UMAP 2D positions + nearest-neighbor similarity.
4. **UI** — search centers your book; similar titles ring by similarity; explore mode shows the full map.

## Deploy to GitHub Pages

Push the repo, enable **Settings → Pages → GitHub Actions**, and push to `main`. See `.github/workflows/deploy.yml`.

For a project site at `https://<user>.github.io/<repo>/`, set `base: '/<repo>/'` in `vite.config.js`.

## Customize

- Increase `--limit` for a denser map (slower build, more API calls).
- Edit `SUBJECT_SHELVES` in `scripts/build_books_data.py` for different subject mix.

## License

MIT — book metadata © [Open Library](https://openlibrary.org/) contributors.
