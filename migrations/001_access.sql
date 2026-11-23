-- SRECRM access control (Supabase). Paste into SQL Editor and Run once.
-- Supabase holds ONLY what RLS needs: who is signed in (auth.users), their board name and role
-- (members), and per-contact access facts (contact_access). Names, emails and outreach stay in the
-- Google Sheet (or data/sample for the public demo). Nothing here is ever written back to the sheet.

-- 1. Board members. A row is created automatically at sign-up with role 'member' and no board name.
--    Only an admin (in this SQL editor) sets full_name and role, so nobody can sign up as an owner.
create table public.members (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  email     text not null,
  full_name text,                        -- must match the sheet's Owner value, e.g. 'Sample Owner A'
  role      text not null default 'member' check (role in ('admin', 'approver', 'member')),
  created_at timestamptz not null default now()
);

-- 2. Access facts per contact: the four fields the rule needs, keyed by the sheet's Contact_ID.
create table public.contact_access (
  contact_id text primary key,
  owner_name text,
  approval   text,                       -- sample: Approved / Pending / Do Not Contact; real sheet: Yes / No
  owner_hold boolean not null default false
);

alter table public.members        enable row level security;
alter table public.contact_access enable row level security;

-- Role of the signed-in person. security definer so policies can read members without recursion.
create or replace function public.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.members where user_id = auth.uid()
$$;

create or replace function public.my_name() returns text
language sql stable security definer set search_path = '' as $$
  select full_name from public.members where user_id = auth.uid()
$$;

-- Read policies only. There are NO insert/update/delete policies, so the publishable key
-- (and any signed-in user) can't change these tables. Admins edit them here in the SQL editor.
create policy "read own member row, admins read all" on public.members
  for select to authenticated
  using (user_id = auth.uid() or public.my_role() = 'admin');

-- The Nov 17 rule:
--   admins and approvers: every contact
--   Do Not Contact: admins and approvers only
--   the contact's owner: always (unless Do Not Contact)
--   other members: only if approved and the owner hasn't put a hold on outreach
create policy "contacts this person may work" on public.contact_access
  for select to authenticated
  using (
    public.my_role() in ('admin', 'approver')
    or (
      coalesce(approval, '') <> 'Do Not Contact'
      and (
        (owner_name is not null and owner_name = public.my_name())
        or (approval in ('Approved', 'Yes') and not owner_hold)
      )
    )
  );

-- New sign-up -> members row with role 'member'.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.members (user_id, email) values (new.id, new.email);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Demo seed: the made-up contacts in data/sample/sample.json (no real people).
insert into public.contact_access (contact_id, owner_name, approval, owner_hold) values
  ('C001', 'Sample Owner A', 'Approved', false),
  ('C002', 'Sample Owner A', 'Approved', false),
  ('C003', 'Sample Owner B', 'Pending', false),
  ('C004', 'Sample Owner C', 'Approved', false),
  ('C005', 'Sample Owner C', 'Approved', false),
  ('C006', 'Sample Owner B', 'Do Not Contact', false),
  ('C007', null, 'Pending', false),
  ('C008', 'Sample Owner A', 'Approved', true),
  ('C009', 'Sample Owner A', 'Approved', false),
  ('C010', 'Sample Owner D', 'Approved', false),
  ('C011', 'Sample Owner D', 'Approved', false),
  ('C012', 'Sample Owner C', 'Approved', false);
