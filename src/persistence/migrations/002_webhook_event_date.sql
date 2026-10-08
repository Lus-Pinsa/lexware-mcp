-- Persist Lexware's event timestamp so durable pending-event reads preserve
-- the existing queue contract without retaining the signed webhook body.
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS event_date timestamptz;

-- Defensive upgrade path for any pre-v2 rows. Persistence has not been enabled
-- in production yet, but an interrupted/dev rollout still upgrades without a
-- NOT NULL failure. received_at is the conservative fallback instant.
UPDATE webhook_events
  SET event_date = received_at
  WHERE event_date IS NULL;

ALTER TABLE webhook_events
  ALTER COLUMN event_date SET NOT NULL;

CREATE INDEX IF NOT EXISTS webhook_events_pending_event_date_idx
  ON webhook_events (tenant_id, event_date, received_at)
  WHERE acknowledged_at IS NULL;
