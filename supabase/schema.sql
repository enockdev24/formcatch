-- Formcatch database schema
-- Run this once: Supabase dashboard → SQL Editor → New query → paste all of
-- this → Run. You only do this one time, when setting up.

-- One row per customer's protected site.
create table sites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  name text not null default 'My site',
  plan text not null default 'free' check (plan in ('free','starter','team','agency')),
  submissions_this_month int not null default 0,
  month_reset_at date not null default date_trunc('month', now()),
  created_at timestamptz not null default now()
);

-- One row per form submission that passed through the filter.
create table submissions (
  id bigserial primary key,
  site_id uuid references sites(id) not null,
  status text not null check (status in ('pass','catch')),
  reason text,
  created_at timestamptz not null default now()
);

-- Row Level Security: a logged-in customer can only ever see their OWN
-- sites and submissions — never another customer's. This is what makes
-- multi-tenancy safe.
alter table sites enable row level security;
alter table submissions enable row level security;

create policy "Users see their own sites"
  on sites for select
  using (auth.uid() = user_id);

create policy "Users update their own sites"
  on sites for update
  using (auth.uid() = user_id);

create policy "Users insert their own sites"
  on sites for insert
  with check (auth.uid() = user_id);

create policy "Users see their own submissions"
  on submissions for select
  using (site_id in (select id from sites where user_id = auth.uid()));

-- Note: the submissions table is written to by a server-side function
-- using a service-role key, which bypasses these policies entirely (on
-- purpose — the public filter endpoint isn't a logged-in user). That key
-- must never be used in any browser-side code.
