-- ISS-003-R2-F1: the append-only audit guard in 0001 used FOR EACH ROW triggers,
-- which do not fire on TRUNCATE. A single TRUNCATE could wipe the entire audit
-- trail, defeating SECURITY.md 2.18. Add a statement-level TRUNCATE guard using
-- the same guard function (it raises from TG_OP, so it works unchanged), and
-- revoke the mutating grants from PUBLIC as defense in depth.

DROP TRIGGER IF EXISTS psl_audit_events_no_truncate ON "psl_audit_events";--> statement-breakpoint
CREATE TRIGGER psl_audit_events_no_truncate
  BEFORE TRUNCATE ON "psl_audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION psl_audit_events_append_only();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "psl_audit_events" FROM PUBLIC;
