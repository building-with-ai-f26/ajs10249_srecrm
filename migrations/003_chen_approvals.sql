-- Chen Institute approvals. Paste into the Supabase SQL Editor and Run once.
-- Adds a 'chen' role. Chen members see every contact (to review it) and are the ONLY people who can
-- change contact_access.approval, and only that column. Nothing else in these tables becomes writable.
-- The decision itself (and any note) is recorded in the sheet's Approval_Log tab, not here.

-- 1. Allow the new role.
alter table public.members drop constraint members_role_check;
alter table public.members add constraint members_role_check
  check (role in ('admin', 'approver', 'chen', 'member'));

-- 2. Chen members can see every contact, like admins and approvers (they need to, to decide).
drop policy "contacts this person may work" on public.contact_access;
create policy "contacts this person may work" on public.contact_access
  for select to authenticated
  using (
    public.my_role() in ('admin', 'approver', 'chen')
    or (
      coalesce(approval, '') <> 'Do Not Contact'
      and (
        (owner_name is not null and owner_name = public.my_name())
        or (approval in ('Approved', 'Yes') and not owner_hold)
      )
    )
  );

-- 3. Column-level grants: signed-in users may only ever touch approval (and contact_id on a new row).
--    owner_name and owner_hold stay read-only for everyone through the API.
grant update (approval) on public.contact_access to authenticated;
grant insert (contact_id, approval) on public.contact_access to authenticated;

-- 4. ...and RLS narrows that to Chen members, with only Yes or No as values.
create policy "chen sets approval" on public.contact_access
  for update to authenticated
  using (public.my_role() = 'chen')
  with check (public.my_role() = 'chen' and approval in ('Yes', 'No'));

create policy "chen adds approval for a new contact" on public.contact_access
  for insert to authenticated
  with check (public.my_role() = 'chen' and approval in ('Yes', 'No') and owner_name is null and owner_hold = false);

-- 5. Make a Chen account (after they sign up in the app). Replace the email, then run this line:
-- update public.members set role = 'chen', full_name = 'Chen Institute reviewer' where email = 'their.email@example.com';
