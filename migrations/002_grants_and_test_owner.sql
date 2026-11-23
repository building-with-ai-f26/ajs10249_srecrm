-- This project doesn't auto-grant new tables to the API roles, so signed-in users got
-- "permission denied" before RLS even ran. Grant READ ONLY to signed-in users; RLS then picks the rows.
-- anon (not signed in) gets nothing, and nobody gets insert/update/delete through the API.
grant select on public.members, public.contact_access to authenticated;
grant execute on function public.my_role(), public.my_name() to authenticated;

-- Security-test setup: Account A is "Sample Owner B", owner of C003 (Pending approval).
-- Account B stays a plain member, so it must NOT see C003's email.
update public.members set full_name = 'Sample Owner B' where email = 'srecrm.test.a@example.com';
