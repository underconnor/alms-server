CREATE TABLE analytics_events (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  delivery_uuid uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  PRIMARY KEY(user_id,event_id),
  CHECK(payload - ARRAY['eventId','eventName','analyticsId','sessionId','occurredMinute','sessionSequence','uiVersion','screen','properties'] = '{}'::jsonb),
  CHECK(payload->>'eventName' IN ('page_view','category_select','button_click','interaction_duration','normalized_error')),
  CHECK(jsonb_typeof(payload->'properties')='object')
);
CREATE INDEX analytics_events_owner_time_idx ON analytics_events(user_id,occurred_at);
CREATE INDEX analytics_events_received_idx ON analytics_events(user_id,received_at);
CREATE INDEX analytics_events_retention_idx ON analytics_events(occurred_at);
CREATE TABLE analytics_delivery (
  delivery_uuid uuid PRIMARY KEY REFERENCES analytics_events(delivery_uuid) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  delivered_at timestamptz,
  last_error text CHECK(last_error IN ('network_unavailable','provider_rejected'))
);
CREATE INDEX analytics_delivery_pending_idx ON analytics_delivery(next_attempt_at) WHERE delivered_at IS NULL;
CREATE TABLE analytics_delivery_budget (
  month date PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0)
);
