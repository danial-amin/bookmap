# Bookmap

A [Movie Map](https://www.movie-map.com/)-style site for **books**: type a title and explore similar books on an interactive map. UI matches the warm **Inkwell** design system; **all book data is loaded live** from [Open Library](https://openlibrary.org/) in the browser (no static catalog required to run).

## Quick start

```bash
npm install
npm run dev
```

Open the URL Vite prints. On first load the app fetches ~200+ popular English books from Open Library, computes similarity in-browser, and draws the map. Searches hit Open Library again for titles not already on the map.

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

## Deploy (GitHub Pages)

```bash
npm run build
# push dist to gh-pages, or use the Actions workflow on danial-amin/bookmap
```

Account: **danial-amin** (see `.cursor/rules/github-danial-amin.mdc` in the parent repo).

## License

MIT — book metadata © Open Library contributors.
