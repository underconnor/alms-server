-- Preserve existing events and all original object/name/properties checks.
-- This is the key allowlist from 004 with one server-owned, bounded client ID.
ALTER TABLE analytics_events DROP CONSTRAINT analytics_events_payload_check1;
ALTER TABLE analytics_events ADD CONSTRAINT analytics_events_payload_check1
  CHECK(payload - ARRAY['eventId','eventName','analyticsId','sessionId','occurredMinute','sessionSequence','uiVersion','screen','properties','clientId'] = '{}'::jsonb);
ALTER TABLE analytics_events ADD CONSTRAINT analytics_events_frontend_client_check
  CHECK(NOT (payload ? 'clientId') OR
    (jsonb_typeof(payload->'clientId')='string' AND payload->>'clientId' ~ '^[a-z0-9][a-z0-9_-]{0,63}$'));
