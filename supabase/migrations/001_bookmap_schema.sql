-- Bookmap: profiles + personal book lists (run in Supabase SQL editor)

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

-- status: read | reading | want
create table if not exists public.user_books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  bookmap_id text not null,
  open_library_key text,
  title text not null,
  author text not null default 'Unknown',
  year int,
  cover_i int,
  status text not null default 'read' check (status in ('read', 'reading', 'want')),
  created_at timestamptz not null default now(),
  unique (user_id, bookmap_id)
);

create index if not exists user_books_user_status_idx
  on public.user_books (user_id, status);

alter table public.user_books enable row level security;

create policy "user_books_select_own" on public.user_books
  for select using (auth.uid() = user_id);

create policy "user_books_insert_own" on public.user_books
  for insert with check (auth.uid() = user_id);

create policy "user_books_update_own" on public.user_books
  for update using (auth.uid() = user_id);

create policy "user_books_delete_own" on public.user_books
  for delete using (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
