-- Enable pgvector (Supabase has it pre-installed, just enable)
create extension if not exists vector with schema extensions;

-- Central book catalog with embeddings
create table if not exists public.books (
  id text primary key,
  open_library_key text unique,
  title text not null,
  author text not null default 'Unknown',
  year int,
  cover_i int,
  subjects text[] not null default '{}',
  description text not null default '',
  snippet text not null default '',
  embedding vector(384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists books_embedding_idx
  on public.books
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 50);

create index if not exists books_title_idx
  on public.books using gin (to_tsvector('english', title));

-- Public read access (no auth needed to browse catalog)
alter table public.books enable row level security;

create policy "books_public_read" on public.books
  for select using (true);

-- Only service_role / server can insert/update books
create policy "books_service_write" on public.books
  for all using (auth.role() = 'service_role');

-- Find similar books by embedding cosine distance
create or replace function public.find_similar_books(
  query_embedding vector(384),
  match_count int default 30,
  exclude_ids text[] default '{}'
)
returns table (
  id text,
  title text,
  author text,
  year int,
  cover_i int,
  subjects text[],
  description text,
  open_library_key text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    b.id,
    b.title,
    b.author,
    b.year,
    b.cover_i,
    b.subjects,
    b.description,
    b.open_library_key,
    1 - (b.embedding <=> query_embedding) as similarity
  from public.books b
  where b.embedding is not null
    and b.id != all(exclude_ids)
  order by b.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Get embedding for a specific book (so frontend can use it as query vector)
create or replace function public.get_book_embedding(book_id text)
returns vector(384)
language sql
stable
as $$
  select embedding from public.books where id = book_id;
$$;

-- Search books by title text (for autocomplete / lookup)
create or replace function public.search_books_by_title(
  query text,
  match_count int default 20
)
returns table (
  id text,
  title text,
  author text,
  year int,
  cover_i int,
  subjects text[],
  description text,
  open_library_key text
)
language plpgsql
as $$
begin
  return query
  select
    b.id, b.title, b.author, b.year, b.cover_i,
    b.subjects, b.description, b.open_library_key
  from public.books b
  where to_tsvector('english', b.title) @@ plainto_tsquery('english', query)
     or b.title ilike '%' || query || '%'
  order by
    ts_rank(to_tsvector('english', b.title), plainto_tsquery('english', query)) desc
  limit match_count;
end;
$$;
