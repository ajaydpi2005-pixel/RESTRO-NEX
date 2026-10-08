-- Phase 9 follow-up: complete_table was revoked from every role, including
-- service_role, so the floor "complete table" action (which runs through the
-- service-role admin client after requirePermission) failed with
-- "permission denied". Restore execute for service_role only. The function
-- still re-checks outlet access and the billing gate in SQL.

grant execute on function public.complete_table(uuid, uuid) to service_role;
