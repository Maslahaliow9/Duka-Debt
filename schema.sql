-- Duka Debt: database schema
-- Run this once in your Supabase project's SQL Editor (Supabase Dashboard -> SQL Editor -> New query)

-- Customers table: each shopkeeper's list of customers
create table customers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  phone text,
  created_at timestamptz not null default now()
);

-- Debts table: each amount a customer owes
create table debts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  amount numeric not null check (amount > 0),
  description text,
  created_at timestamptz not null default now(),
  paid boolean not null default false,
  paid_at timestamptz
);

-- Turn on Row Level Security so shopkeepers can only ever see their own data
alter table customers enable row level security;
alter table debts enable row level security;

-- Policies: a shopkeeper can only read/write rows where they are the owner
create policy "Owners manage their own customers"
  on customers for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "Owners manage their own debts"
  on debts for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- Helpful index for the dashboard query (unpaid debts per customer)
create index debts_customer_paid_idx on debts (customer_id, paid);
