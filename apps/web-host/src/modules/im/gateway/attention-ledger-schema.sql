-- Node专用accepted投递证据。经备份/审查后显式执行；应用不得自动建表。
BEGIN;
CREATE TABLE gugu_im_accepted_delivery_facts (
  user_id uuid NOT NULL,
  session_id integer NOT NULL,
  run_id varchar(128) NOT NULL,
  delivery_key varchar(200) NOT NULL,
  attempt_id uuid NOT NULL,
  scope_hash varchar(64) NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  final_event_sequence bigint,
  final_confirmed_at timestamptz,
  event_sequence bigint NOT NULL CHECK(event_sequence>0),
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 16 AND 65552),
  CHECK ((final_event_sequence IS NULL)=(final_confirmed_at IS NULL)),
  CHECK (final_event_sequence IS NULL OR final_event_sequence>=event_sequence),
  PRIMARY KEY(user_id,session_id,run_id,delivery_key),
  FOREIGN KEY(user_id,session_id,run_id,delivery_key)
    REFERENCES gugu_im_delivery_receipts(user_id,session_id,run_id,delivery_key) ON DELETE CASCADE
);
CREATE INDEX ix_gugu_im_accepted_scope_time ON gugu_im_accepted_delivery_facts(user_id,scope_hash,accepted_at DESC);
COMMIT;
