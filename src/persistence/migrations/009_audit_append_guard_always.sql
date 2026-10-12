-- Append guard always on (schema v9). A trigger in the default state ('O') does not fire when a session runs with
-- session_replication_role = replica, which a role may be granted the right to set (PostgreSQL 15+: GRANT SET ON
-- PARAMETER). ENABLE ALWAYS makes the guard fire in every replication-role mode. Start-up additionally rejects a
-- runtime role holding any parameter privilege and verifies that the guard is enabled ALWAYS.
ALTER TABLE public.audit_events ENABLE ALWAYS TRIGGER audit_events_append_guard;
