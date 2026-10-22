CREATE TABLE school_read_cache (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  generation uuid NOT NULL,
  resource_key text NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 512),
  encrypted_payload text NOT NULL CHECK (octet_length(encrypted_payload) <= 1400000),
  payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 1 AND 1048576),
  stored_bytes integer NOT NULL CHECK (stored_bytes BETWEEN 1 AND 1400000),
  expires_at timestamptz NOT NULL,
  accessed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider, generation, resource_key)
);
CREATE INDEX school_read_cache_expiry_idx ON school_read_cache(expires_at);
CREATE INDEX school_read_cache_access_idx ON school_read_cache(accessed_at);
