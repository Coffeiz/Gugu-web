-- 仅供审查：由调用方在已验证备份与依赖表后，在单个写事务中执行。
CREATE TABLE conversation_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, title_locked INTEGER NOT NULL, summary TEXT NOT NULL, source TEXT NOT NULL,
  bot_id TEXT, chat_id TEXT, platform_user_id TEXT, chat_type TEXT,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  context_epoch INTEGER NOT NULL, session_context TEXT, session_info_hash TEXT, snapshot_hash TEXT,
  snapshot_expires_at TEXT, baseline_message_seq INTEGER NOT NULL DEFAULT 0, baseline_message_hash TEXT,
  last_message_seq INTEGER NOT NULL DEFAULT 0, execution_state TEXT NOT NULL DEFAULT 'idle',
  active_run_id TEXT, pending_message_count INTEGER NOT NULL DEFAULT 0,
  history_provider TEXT, history_api_format TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX ix_conversation_sessions_user_id ON conversation_sessions(user_id);
CREATE INDEX ix_conversation_sessions_bot_id ON conversation_sessions(bot_id);
CREATE INDEX ix_conversation_sessions_chat_id ON conversation_sessions(chat_id);
CREATE INDEX ix_conversation_sessions_platform_user_id ON conversation_sessions(platform_user_id);
CREATE INDEX ix_conversation_sessions_workspace_id ON conversation_sessions(workspace_id);
CREATE INDEX ix_conversation_sessions_session_info_hash ON conversation_sessions(session_info_hash);
CREATE INDEX ix_conversation_sessions_snapshot_hash ON conversation_sessions(snapshot_hash);
CREATE INDEX ix_conversation_sessions_snapshot_expires_at ON conversation_sessions(snapshot_expires_at);
CREATE INDEX ix_conversation_sessions_baseline_message_seq ON conversation_sessions(baseline_message_seq);
CREATE INDEX ix_conversation_sessions_execution_state ON conversation_sessions(execution_state);
CREATE TABLE conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  conversation_seq INTEGER NOT NULL, history_anchor_seq INTEGER, role TEXT NOT NULL, content TEXT NOT NULL,
  client_message_id TEXT, content_json TEXT, provider_image_content TEXT, display_timeline TEXT, files TEXT,
  quoted_text TEXT, references_json TEXT, platform_user_id TEXT, platform_user_name TEXT, platform_bot_user_id TEXT,
  im_platform_message_id TEXT, im_reply_to_message_id TEXT, im_reply_target_sender_id TEXT,
  im_reply_target_is_bot INTEGER, im_sender_is_bot INTEGER, im_event_received_ms INTEGER, im_platform_sent_ms INTEGER,
  im_media_kinds TEXT, im_media_processable INTEGER, im_mention_facts TEXT, chat_type TEXT, sent_at TEXT,
  created_at TEXT NOT NULL, canonical_batch_id INTEGER REFERENCES conversation_batches(id) ON DELETE SET NULL,
  run_id TEXT, round_id TEXT, run_outcome TEXT, covers_until_seq INTEGER
);
CREATE UNIQUE INDEX uq_conversation_messages_session_client_message_id ON conversation_messages(session_id,client_message_id);
CREATE UNIQUE INDEX uq_conversation_messages_session_sequence ON conversation_messages(session_id,conversation_seq);
CREATE INDEX ix_conversation_messages_session_id ON conversation_messages(session_id);
CREATE INDEX ix_conversation_messages_platform_user_id ON conversation_messages(platform_user_id);
CREATE INDEX ix_conversation_messages_platform_bot_user_id ON conversation_messages(platform_bot_user_id);
CREATE INDEX ix_conversation_messages_im_platform_message_id ON conversation_messages(im_platform_message_id);
CREATE INDEX ix_conversation_messages_im_event_received_ms ON conversation_messages(im_event_received_ms);
CREATE INDEX ix_conversation_messages_sent_at ON conversation_messages(sent_at);
CREATE INDEX ix_conversation_messages_canonical_batch_id ON conversation_messages(canonical_batch_id);
CREATE INDEX ix_conversation_messages_run_id ON conversation_messages(run_id);
CREATE TABLE conversation_pending_queues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  queue_id TEXT NOT NULL, session_id INTEGER REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  items TEXT NOT NULL, updated_at TEXT NOT NULL,
  CONSTRAINT uq_conversation_pending_queue_owner_key UNIQUE(user_id,queue_id)
);
CREATE INDEX ix_conversation_pending_queues_user_id ON conversation_pending_queues(user_id);
CREATE INDEX ix_conversation_pending_queues_session_id ON conversation_pending_queues(session_id);
