import { definePostgresMigration } from '../runner.js'

export const imGatewaySql = {
  admission: `
CREATE TABLE gugu_im_gateway_admissions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
  bot_id integer NOT NULL REFERENCES user_bots(id) ON DELETE CASCADE,
  chat_type varchar(20) NOT NULL CHECK(chat_type IN ('c2c','group')),
  scope_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  fingerprint char(64) NOT NULL,
  state varchar(16) NOT NULL CHECK(state IN ('pending','admitted','consumed','unknown')),
  token varchar(128),
  first_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,platform,bot_id,chat_type,scope_hash,event_hash),
  CHECK((state='pending' AND token IS NOT NULL) OR (state<>'pending' AND token IS NULL))
);
CREATE INDEX ix_gugu_im_gateway_admission_health ON gugu_im_gateway_admissions(user_id,bot_id,state) WHERE state IN ('pending','unknown');
`,
  conversation: `
CREATE TABLE gugu_im_inbound_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
  bot_id varchar(128) NOT NULL,
  chat_type varchar(20) NOT NULL CHECK(chat_type IN ('group','c2c')),
  scope_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  fingerprint char(64) NOT NULL,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  message_id integer NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  state varchar(16) NOT NULL CHECK(state IN ('staged','passive','dispatched')),
  run_id varchar(128),
  sealed_payload jsonb NOT NULL,
  PRIMARY KEY(user_id,platform,bot_id,chat_type,scope_hash,event_hash),
  CHECK((state IN ('staged','passive') AND run_id IS NULL) OR (state='dispatched' AND run_id IS NOT NULL))
);
CREATE INDEX ix_gugu_im_inbound_run ON gugu_im_inbound_receipts(user_id,session_id,run_id) WHERE run_id IS NOT NULL;
CREATE TABLE gugu_im_inbound_segments (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
  bot_id varchar(128) NOT NULL,
  chat_type varchar(20) NOT NULL CHECK(chat_type IN ('group','c2c')),
  scope_hash char(64) NOT NULL,
  segment_key char(64) NOT NULL,
  batch_key char(64) NOT NULL,
  segment_index integer NOT NULL CHECK(segment_index>=0),
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  state varchar(16) NOT NULL CHECK(state IN ('started','completed')),
  mode varchar(16) NOT NULL CHECK(mode IN ('dispatch','passive')),
  run_id varchar(128),
  anchors jsonb NOT NULL CHECK(jsonb_typeof(anchors)='array' AND jsonb_array_length(anchors)>0),
  sealed_payload jsonb NOT NULL,
  PRIMARY KEY(user_id,platform,bot_id,chat_type,scope_hash,segment_key),
  CHECK((state='started' AND run_id IS NULL) OR (state='completed' AND ((mode='dispatch' AND run_id IS NOT NULL) OR (mode='passive' AND run_id IS NULL))))
);
CREATE UNIQUE INDEX uq_gugu_im_segment_run ON gugu_im_inbound_segments(user_id,session_id,run_id) WHERE run_id IS NOT NULL;
CREATE TABLE gugu_im_inbound_batch_members (
  user_id uuid NOT NULL, platform varchar(20) NOT NULL, bot_id varchar(128) NOT NULL,
  chat_type varchar(20) NOT NULL, scope_hash char(64) NOT NULL, event_hash char(64) NOT NULL,
  segment_key char(64) NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0),
  PRIMARY KEY(user_id,platform,bot_id,chat_type,scope_hash,event_hash),
  UNIQUE(user_id,platform,bot_id,chat_type,scope_hash,segment_key,ordinal),
  FOREIGN KEY(user_id,platform,bot_id,chat_type,scope_hash,event_hash)
    REFERENCES gugu_im_inbound_receipts(user_id,platform,bot_id,chat_type,scope_hash,event_hash) ON DELETE CASCADE,
  FOREIGN KEY(user_id,platform,bot_id,chat_type,scope_hash,segment_key)
    REFERENCES gugu_im_inbound_segments(user_id,platform,bot_id,chat_type,scope_hash,segment_key) ON DELETE CASCADE
);
`,
  delivery: `
CREATE TABLE gugu_im_run_delivery (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  PRIMARY KEY (user_id, session_id, run_id)
);
CREATE TABLE gugu_im_delivery_receipts (
  user_id uuid NOT NULL,
  session_id integer NOT NULL,
  run_id varchar(128) NOT NULL,
  delivery_key varchar(200) NOT NULL,
  fingerprint varchar(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  state varchar(12) NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'unknown')),
  attempt_id uuid NOT NULL,
  PRIMARY KEY (user_id, session_id, run_id, delivery_key),
  FOREIGN KEY (user_id, session_id, run_id) REFERENCES gugu_im_run_delivery(user_id, session_id, run_id) ON DELETE CASCADE
);
CREATE TABLE gugu_im_platform_projection (
  user_id uuid NOT NULL,
  session_id integer NOT NULL,
  run_id varchar(128) NOT NULL,
  platform varchar(16) NOT NULL CHECK (platform IN ('feishu','qq','telegram')),
  version bigint NOT NULL CHECK (version>0),
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  payload bytea NOT NULL CHECK (octet_length(payload)<=1048592),
  PRIMARY KEY(user_id,session_id,run_id,platform),
  FOREIGN KEY(user_id,session_id,run_id) REFERENCES gugu_im_run_delivery(user_id,session_id,run_id) ON DELETE CASCADE
);
`,
  attentionLedger: `
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
`,
  bindingConsume: `
CREATE TABLE gugu_im_binding_consumptions (
  platform varchar(20) NOT NULL CHECK (platform IN ('qq','telegram')),
  bot_id integer NOT NULL REFERENCES user_bots(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_digest char(64) NOT NULL CHECK (challenge_digest ~ '^[0-9a-f]{64}$'),
  sender_digest char(64) NOT NULL CHECK (sender_digest ~ '^[0-9a-f]{64}$'),
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(platform,bot_id,challenge_digest)
);
`,
  shortcut: `
CREATE TABLE gugu_im_shortcut_controls (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_hash char(64) NOT NULL,
  reference uuid NOT NULL UNIQUE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  dispatch_sequence bigint NOT NULL,
  facts_hash char(64) NOT NULL,
  state varchar(16) NOT NULL CHECK(state IN ('observed','requested')),
  notification_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,event_hash),
  FOREIGN KEY(user_id,session_id,run_id) REFERENCES agent_run_dispatch(user_id,session_id,run_id) ON DELETE CASCADE
);
`,
  nativeInteraction: `
CREATE TABLE gugu_im_native_deliveries (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivery_hash char(64) NOT NULL,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  prompt_id integer NOT NULL REFERENCES interaction_prompts(id) ON DELETE CASCADE,
  state varchar(12) NOT NULL CHECK(state IN ('pending','accepted','rejected','unknown')),
  attempt_id uuid NOT NULL,
  PRIMARY KEY(user_id,delivery_hash)
);
CREATE TABLE gugu_im_native_prompt_messages (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(16) NOT NULL CHECK(platform IN ('feishu','qq','telegram')),
  bot_id varchar(128) NOT NULL,
  chat_hash char(64) NOT NULL,
  message_hash char(64) NOT NULL,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  prompt_id integer NOT NULL REFERENCES interaction_prompts(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,platform,bot_id,message_hash)
);
`,
  pendingAsk: `
CREATE TABLE gugu_im_pending_ask_runs (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL CHECK(platform IN ('qq','feishu','telegram')),
  bot_id varchar(128) NOT NULL,
  scope_hash char(64) NOT NULL,
  resume_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  message_id integer NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  state varchar(16) NOT NULL CHECK(state IN ('dispatched','consumed')),
  run_id varchar(128),
  PRIMARY KEY(user_id,platform,bot_id,scope_hash,resume_hash),
  CHECK((state='dispatched' AND run_id IS NOT NULL) OR (state='consumed' AND run_id IS NULL))
);
`,
  reaction: `
CREATE TABLE gugu_im_reaction_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  call_hash varchar(64) NOT NULL CHECK (call_hash ~ '^[a-f0-9]{64}$'),
  fingerprint varchar(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  attempt_id uuid NOT NULL,
  state varchar(12) NOT NULL CHECK (state IN ('pending','accepted','rejected','unknown')),
  PRIMARY KEY(user_id,session_id,run_id,call_hash)
);
`,
  production: `
CREATE TABLE gugu_im_runtime_bindings (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 16 AND 65536),
  PRIMARY KEY(user_id,session_id,run_id)
);
`,
  fileTools: `
CREATE TABLE gugu_im_file_tool_receipts (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
 run_id varchar(128) NOT NULL,
 artifact_hash char(64) NOT NULL,
 state varchar(12) NOT NULL CHECK(state IN ('pending','sent','failed','unknown')),
 attempt_id uuid NOT NULL,
 PRIMARY KEY(user_id,session_id,run_id,artifact_hash)
);
`,
  voiceCache: `
CREATE TABLE gugu_im_voice_cache (
  source_key text PRIMARY KEY CHECK (source_key ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  message_id integer NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  attach_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('feishu','qq','telegram','wechat')),
  bot_id varchar(128) NOT NULL,
  scope_hash text NOT NULL,
  event_hash text NOT NULL,
  selection_hash text NOT NULL,
  input_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared','requesting','completed','empty','unavailable','unknown')),
  attempt text NOT NULL,
  nonce bytea,
  sealed_result bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,session_id,message_id,attach_id)
);
CREATE TABLE gugu_im_voice_run_bindings (
  source_key text NOT NULL REFERENCES gugu_im_voice_cache(source_key) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(source_key,run_id)
);
`,
  ownerSession: `
CREATE TABLE gugu_im_owner_sessions (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,scope_hash)
);
CREATE TABLE gugu_im_owner_session_receipts (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
 run_id text NOT NULL,
 round_id text NOT NULL,
 call_id text NOT NULL,
 scope_hash text NOT NULL,
 target_session_id integer NOT NULL,
 status text NOT NULL CHECK(status IN ('bound','denied')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,session_id,run_id,round_id,call_id)
);
`,
  compact: `
CREATE TABLE gugu_im_compact_commands (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_hash text NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  session_id integer REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  operation_id varchar(128) NOT NULL,
  state text NOT NULL CHECK (state IN ('requesting','compacted','not_needed','failed','unknown','busy','no_session')),
  token text,
  fence bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,event_hash),
  UNIQUE(user_id,operation_id)
);
CREATE INDEX gugu_im_compact_session ON gugu_im_compact_commands(user_id,session_id);
`,
  retiredInbound: `
CREATE TABLE gugu_im_retired_inbound (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(20) NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
  bot_id varchar(128) NOT NULL,
  chat_type varchar(20) NOT NULL CHECK(chat_type IN ('c2c','group')),
  scope_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  fingerprint char(64) NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,platform,bot_id,chat_type,scope_hash,event_hash)
);
`,
  historyRetention: `
CREATE TABLE gugu_im_history_retention_targets (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id integer NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
 generation bigint NOT NULL CHECK(generation>0),
 completed_generation bigint NOT NULL DEFAULT 0 CHECK(completed_generation>=0),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,session_id),
 CHECK(completed_generation<=generation)
);
CREATE INDEX ix_gugu_im_retention_ready ON gugu_im_history_retention_targets(next_attempt_at) WHERE generation>completed_generation;
-- 不引用session，避免整会话删除后失去已提交但未完成的FS回收记录。
CREATE TABLE gugu_im_history_retention_storage (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 storage_key text NOT NULL,
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,storage_key)
);
`,
} as const

export const imGateway = definePostgresMigration({
  revision: '0013_im_gateway',
  sql: Object.values(imGatewaySql).join('\n'),
  tables: [
    'gugu_im_gateway_admissions', 'gugu_im_inbound_receipts',
    'gugu_im_inbound_segments', 'gugu_im_inbound_batch_members',
    'gugu_im_run_delivery', 'gugu_im_delivery_receipts',
    'gugu_im_platform_projection', 'gugu_im_accepted_delivery_facts',
    'gugu_im_binding_consumptions', 'gugu_im_shortcut_controls',
    'gugu_im_native_deliveries', 'gugu_im_native_prompt_messages',
    'gugu_im_pending_ask_runs', 'gugu_im_reaction_receipts',
    'gugu_im_runtime_bindings', 'gugu_im_file_tool_receipts',
    'gugu_im_voice_cache', 'gugu_im_voice_run_bindings',
    'gugu_im_owner_sessions', 'gugu_im_owner_session_receipts',
    'gugu_im_compact_commands', 'gugu_im_retired_inbound',
    'gugu_im_history_retention_targets', 'gugu_im_history_retention_storage',
  ],
  prerequisites: ['users', 'user_bots', 'conversation_sessions', 'conversation_messages', 'interaction_prompts', 'agent_run_dispatch'],
})
