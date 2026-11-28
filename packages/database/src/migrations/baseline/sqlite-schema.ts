// SQLite 当前基线。未来结构变更登记到逻辑迁移清单。
export const sqliteBaselineSql = `CREATE TABLE projects (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL, name VARCHAR(200) NOT NULL, summary VARCHAR(200), contact_name VARCHAR(200), status VARCHAR(20) NOT NULL, start_date VARCHAR(10), deadline VARCHAR(10), color VARCHAR(300) NOT NULL, progress INTEGER NOT NULL, stages_json TEXT NOT NULL, current_stage VARCHAR(100), priority VARCHAR(20), version INTEGER NOT NULL, archived BOOLEAN NOT NULL, done_at DATETIME, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, deleted_at DATETIME, idempotency_key VARCHAR(64), idempotency_fingerprint VARCHAR(64), CONSTRAINT uq_projects_user_idempotency_key UNIQUE (user_id,idempotency_key));

CREATE TABLE clients (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL, name VARCHAR(200) NOT NULL, contact VARCHAR(200), email VARCHAR(300), phone VARCHAR(50), notes TEXT NOT NULL, created_at DATETIME NOT NULL);

CREATE TABLE core_operation_receipts (owner_id CHAR(32) NOT NULL, operation_id VARCHAR(36) NOT NULL, fingerprint VARCHAR(64) NOT NULL, method VARCHAR(100) NOT NULL, result_json TEXT NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (owner_id, operation_id));

CREATE TABLE undo_operations (id VARCHAR(80) PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL, undo_context_id VARCHAR(128) NOT NULL, group_id VARCHAR(80) NOT NULL, resource VARCHAR(32) NOT NULL, action VARCHAR(32) NOT NULL, target_refs TEXT NOT NULL, before_state TEXT NOT NULL, after_state TEXT NOT NULL, base_versions TEXT NOT NULL, artifact_refs TEXT NOT NULL, actor_type VARCHAR(32) NOT NULL, status VARCHAR(24) NOT NULL, created_at DATETIME NOT NULL, undone_at DATETIME, expires_at DATETIME, failure_code VARCHAR(80));

CREATE TABLE mind_nodes (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL, kind VARCHAR(20) NOT NULL, title VARCHAR(300), content_md TEXT NOT NULL, content_plain TEXT NOT NULL, color VARCHAR(300), ref_type VARCHAR(20), ref_id INTEGER, ref_snapshot TEXT, origin VARCHAR(10) NOT NULL, indexed_at DATETIME, indexed_hash VARCHAR(64), version INTEGER NOT NULL, captured_at DATETIME NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, deleted_at DATETIME, CONSTRAINT uq_mind_node_ref UNIQUE (user_id, ref_type, ref_id), CONSTRAINT ck_mind_node_ref_shape CHECK ((kind = 'ref' AND ref_type IS NOT NULL AND ref_id IS NOT NULL) OR (kind <> 'ref' AND ref_type IS NULL AND ref_id IS NULL)));

CREATE TABLE mind_maps (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL, title VARCHAR(300) NOT NULL, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, data_json TEXT NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, deleted_at DATETIME);

CREATE TABLE calendar_events (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL, title VARCHAR(300) NOT NULL, date VARCHAR(10) NOT NULL, time VARCHAR(5), end_time VARCHAR(5), type VARCHAR(50) NOT NULL, contact_name VARCHAR(200), project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, description TEXT, version INTEGER NOT NULL, created_at DATETIME NOT NULL, deleted_at DATETIME, idempotency_key VARCHAR(64), idempotency_fingerprint VARCHAR(64), CONSTRAINT uq_calendar_events_user_idempotency_key UNIQUE(user_id,idempotency_key));

CREATE TABLE rag_index_jobs (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL, source_type VARCHAR(32) NOT NULL, source_id VARCHAR(255) NOT NULL, pending_source_ids TEXT, version VARCHAR(64) NOT NULL, operation VARCHAR(24) NOT NULL, status VARCHAR(16) NOT NULL, generation INTEGER NOT NULL, completed_generation INTEGER NOT NULL, attempts INTEGER NOT NULL, next_attempt_at DATETIME, lease_until DATETIME, last_error_code VARCHAR(64), last_started_at DATETIME, last_succeeded_at DATETIME, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, CONSTRAINT uq_rag_index_job_user_source UNIQUE(user_id,source_type));

CREATE TABLE knowledge_index_entries (id INTEGER PRIMARY KEY NOT NULL, owner_user_id CHAR(32) NOT NULL, source_type VARCHAR(32) NOT NULL, source_id VARCHAR(255) NOT NULL, scope_type VARCHAR(32) NOT NULL DEFAULT 'owner', scope_id VARCHAR(255) NOT NULL DEFAULT '', platform VARCHAR(32) NOT NULL DEFAULT '', bot_id VARCHAR(128) NOT NULL DEFAULT '', group_id VARCHAR(255) NOT NULL DEFAULT '', document_id VARCHAR(255) NOT NULL, parent_document_id VARCHAR(255), document_version VARCHAR(64) NOT NULL, chunk_index INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 1, title VARCHAR(300) NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', content_hash VARCHAR(64) NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', source_updated_at DATETIME, indexed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME, CONSTRAINT uq_knowledge_index_entry_chunk UNIQUE(owner_user_id,source_type,source_id,document_version,chunk_index));

CREATE TABLE mind_canvas_items (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL, canvas_id INTEGER NOT NULL REFERENCES mind_maps(id) ON DELETE CASCADE, node_id INTEGER NOT NULL REFERENCES mind_nodes(id) ON DELETE CASCADE, x FLOAT NOT NULL, y FLOAT NOT NULL, w FLOAT, h FLOAT, z INTEGER NOT NULL, collapsed BOOLEAN NOT NULL, data_json TEXT NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, deleted_at DATETIME, CONSTRAINT uq_canvas_node UNIQUE(canvas_id,node_id));

CREATE TABLE mind_relations (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL, canvas_id INTEGER REFERENCES mind_maps(id) ON DELETE CASCADE, src_node_id INTEGER NOT NULL REFERENCES mind_nodes(id) ON DELETE CASCADE, dst_node_id INTEGER NOT NULL REFERENCES mind_nodes(id) ON DELETE CASCADE, rel_type VARCHAR(20) NOT NULL, edge_key VARCHAR(32) NOT NULL, origin VARCHAR(10) NOT NULL, status VARCHAR(10) NOT NULL, note TEXT, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, deleted_at DATETIME, CONSTRAINT uq_mind_relation UNIQUE(user_id,canvas_id,src_node_id,dst_node_id,rel_type,edge_key), CONSTRAINT ck_mind_relation_no_self CHECK(src_node_id <> dst_node_id));

CREATE TABLE scheduled_tasks (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32), event_id INTEGER, reminder_lead_minutes INTEGER, workspace_id INTEGER, filesystem_authorization_grant_id INTEGER, name VARCHAR(100) NOT NULL, payload TEXT NOT NULL, cron VARCHAR(60) NOT NULL, schedule_kind VARCHAR(16) NOT NULL DEFAULT 'cron', interval_minutes INTEGER, start_at DATETIME, end_at DATETIME, channels VARCHAR(40) NOT NULL, enabled BOOLEAN NOT NULL, delivery_targets TEXT, authorized_tools TEXT NOT NULL DEFAULT '[]', email_attachment_file_paths TEXT NOT NULL DEFAULT '[]', last_run_at DATETIME, last_run_failed BOOLEAN, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, execution_mode TEXT NOT NULL DEFAULT 'reminder' CHECK(execution_mode IN ('reminder', 'instruction')), CHECK(workspace_id IS NULL AND filesystem_authorization_grant_id IS NULL));

CREATE TABLE scheduled_task_fires (task_id INTEGER NOT NULL, fire_at DATETIME NOT NULL, lease_owner VARCHAR(128) NOT NULL, status VARCHAR(16) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(task_id,fire_at));

CREATE TABLE site_notifications (id INTEGER PRIMARY KEY NOT NULL, title VARCHAR(200) NOT NULL, content TEXT NOT NULL, color VARCHAR(50) NOT NULL, target VARCHAR(50) NOT NULL, bubble BOOLEAN NOT NULL, persist BOOLEAN NOT NULL, bubble_expire_at DATETIME, created_by VARCHAR(100) NOT NULL, created_at DATETIME NOT NULL);

CREATE TABLE notification_reads (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL, notification_id INTEGER NOT NULL REFERENCES site_notifications(id) ON DELETE CASCADE, read_at DATETIME NOT NULL, CONSTRAINT uq_notif_read UNIQUE(user_id,notification_id));

CREATE TABLE notification_dismissals (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL, notification_id INTEGER NOT NULL REFERENCES site_notifications(id) ON DELETE CASCADE, dismissed_at DATETIME NOT NULL, CONSTRAINT uq_notif_dismissal UNIQUE(user_id,notification_id));

CREATE TABLE user_smtp_configs (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL UNIQUE, host VARCHAR(255) NOT NULL, port INTEGER NOT NULL, "user" VARCHAR(300) NOT NULL, password TEXT NOT NULL, from_addr VARCHAR(300) NOT NULL, use_ssl BOOLEAN NOT NULL, enabled BOOLEAN NOT NULL, updated_at DATETIME NOT NULL);

CREATE TABLE onboarding_state (user_id CHAR(32) PRIMARY KEY NOT NULL, state TEXT NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL);

CREATE TABLE feedbacks (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32), username VARCHAR(64) NOT NULL, category VARCHAR(32) NOT NULL, content TEXT NOT NULL, created_at DATETIME NOT NULL);

CREATE TABLE user_preferences (id INTEGER PRIMARY KEY NOT NULL, user_id CHAR(32) NOT NULL UNIQUE, data_json TEXT NOT NULL, updated_at DATETIME NOT NULL);

CREATE TABLE user_mcp_servers (id TEXT PRIMARY KEY NOT NULL, user_id CHAR(32), scope VARCHAR(16) NOT NULL DEFAULT 'user', name VARCHAR(64) NOT NULL, transport VARCHAR(16) NOT NULL DEFAULT 'http', endpoint VARCHAR(1000) NOT NULL DEFAULT '', encrypted_headers TEXT NOT NULL DEFAULT '', headers_nonce VARCHAR(64) NOT NULL DEFAULT '', encrypted_headers_key TEXT NOT NULL DEFAULT '', headers_key_version INTEGER NOT NULL DEFAULT 1, enabled BOOLEAN NOT NULL DEFAULT TRUE, confirm_mode VARCHAR(16) NOT NULL DEFAULT 'confirm_all', timeout_seconds INTEGER NOT NULL DEFAULT 30, tool_allowlist TEXT, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, command VARCHAR(1000) NOT NULL DEFAULT '', auth_mode VARCHAR(16) NOT NULL DEFAULT 'headers', encrypted_query_params TEXT NOT NULL DEFAULT '', query_params_nonce VARCHAR(64) NOT NULL DEFAULT '', encrypted_query_params_key TEXT NOT NULL DEFAULT '', query_params_key_version INTEGER NOT NULL DEFAULT 1, encrypted_endpoint TEXT NOT NULL DEFAULT '', endpoint_nonce VARCHAR(64) NOT NULL DEFAULT '', encrypted_endpoint_key TEXT NOT NULL DEFAULT '', endpoint_key_version INTEGER NOT NULL DEFAULT 1, credential_slots TEXT NOT NULL DEFAULT '[]', encrypted_credentials TEXT NOT NULL DEFAULT '', credentials_nonce VARCHAR(64) NOT NULL DEFAULT '', encrypted_credentials_key TEXT NOT NULL DEFAULT '', credentials_key_version INTEGER NOT NULL DEFAULT 1, CONSTRAINT uq_user_mcp_servers_scope_name UNIQUE(user_id,scope,name));

CREATE TABLE user_mcp_tool_schema_snapshots (user_id CHAR(32) PRIMARY KEY NOT NULL, config_digest VARCHAR(64) NOT NULL, schemas TEXT NOT NULL DEFAULT '[]', refreshed_at DATETIME NOT NULL);

CREATE TABLE core_runtime_meta (key VARCHAR(50) PRIMARY KEY NOT NULL,value VARCHAR(100) NOT NULL);

CREATE TABLE conversation_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL CHECK(length(user_id)=32 AND user_id NOT GLOB '*[^0-9a-f]*'),
  title TEXT NOT NULL, title_locked INTEGER NOT NULL, summary TEXT NOT NULL, source TEXT,
  bot_id TEXT, chat_id TEXT, platform_user_id TEXT, chat_type TEXT,
  workspace_id INTEGER CHECK(workspace_id IS NULL),
  context_epoch INTEGER NOT NULL, session_context TEXT, session_info_hash TEXT, snapshot_hash TEXT,
  snapshot_expires_at TEXT, baseline_message_seq INTEGER NOT NULL DEFAULT 0, baseline_message_hash TEXT,
  last_message_seq INTEGER NOT NULL DEFAULT 0, execution_state TEXT NOT NULL DEFAULT 'idle',
  active_run_id TEXT, pending_message_count INTEGER NOT NULL DEFAULT 0,
  history_provider TEXT, history_api_format TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE conversation_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  version TEXT NOT NULL, run_id TEXT, round_id TEXT, digest TEXT NOT NULL,
  state_summary TEXT, created_at TEXT NOT NULL,
  CONSTRAINT uq_conversation_batches_session_digest UNIQUE(session_id,digest)
);

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

CREATE TABLE conversation_pending_queues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL CHECK(length(user_id)=32 AND user_id NOT GLOB '*[^0-9a-f]*'),
  queue_id TEXT NOT NULL, session_id INTEGER,
  items TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id,user_id) REFERENCES conversation_sessions(id,user_id) ON DELETE CASCADE,
  CONSTRAINT uq_conversation_pending_queue_owner_key UNIQUE(user_id,queue_id)
);

CREATE TABLE interaction_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL CHECK(length(user_id)=32 AND user_id NOT GLOB '*[^0-9a-f]*'),
  session_id INTEGER NOT NULL,
  kind VARCHAR(20) NOT NULL,
  title VARCHAR(300) NOT NULL,
  body TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  status VARCHAR(20) NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id,user_id) REFERENCES conversation_sessions(id,user_id) ON DELETE CASCADE
);

CREATE TABLE interaction_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id INTEGER NOT NULL REFERENCES interaction_prompts(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  action_type VARCHAR(30) NOT NULL,
  option_id VARCHAR(100) NOT NULL,
  context_json TEXT NOT NULL,
  status VARCHAR(20) NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_event_id VARCHAR(200),
  created_at TEXT NOT NULL
);

CREATE TABLE user_skills (
    id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, skill_id TEXT NOT NULL,
    name TEXT NOT NULL, description_short TEXT NOT NULL, description_long TEXT,
    category TEXT NOT NULL, body TEXT NOT NULL, related_tools TEXT NOT NULL,
    source TEXT NOT NULL, managed_by TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    content_digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(owner_id,skill_id)
  );

CREATE TABLE agent_run_leases (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      token TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence > 0), expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY(user_id, session_id),
      FOREIGN KEY(session_id, user_id) REFERENCES conversation_sessions(id, user_id) ON DELETE CASCADE
    );

CREATE TABLE agent_run_admissions (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      user_message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id, session_id, run_id),
      UNIQUE(user_id, session_id, user_message_id),
      FOREIGN KEY(session_id, user_id) REFERENCES conversation_sessions(id, user_id) ON DELETE CASCADE
    );

CREATE TABLE agent_run_controls (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
      startup_failed INTEGER NOT NULL DEFAULT 0 CHECK(startup_failed IN (0, 1)),
      PRIMARY KEY(user_id, session_id, run_id),
      FOREIGN KEY(session_id, user_id) REFERENCES conversation_sessions(id, user_id) ON DELETE CASCADE
    );

CREATE TABLE agent_run_checkpoints (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version >= 0), sequence INTEGER NOT NULL CHECK(sequence >= 0),
      status TEXT NOT NULL, phase TEXT NOT NULL, nonce BLOB NOT NULL, payload BLOB NOT NULL, updated_at_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, session_id, run_id),
      FOREIGN KEY(session_id, user_id) REFERENCES conversation_sessions(id, user_id) ON DELETE CASCADE
    );

CREATE TABLE agent_run_events (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      event_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0),
      nonce BLOB NOT NULL, payload BLOB NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0, 1)), created_at_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, session_id, run_id, sequence),
      UNIQUE(user_id, session_id, run_id, event_id),
      FOREIGN KEY(user_id, session_id, run_id) REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    );

CREATE TABLE agent_run_interaction_receipts (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL, receipt TEXT NOT NULL,
      PRIMARY KEY(user_id, session_id, run_id, receipt),
      FOREIGN KEY(user_id, session_id, run_id) REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    );

CREATE TABLE desktop_agent_memory (
      user_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('profile', 'pattern')),
      body TEXT NOT NULL,
      PRIMARY KEY(user_id, target)
    );

CREATE TABLE desktop_agent_memory_receipts (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      round_id TEXT NOT NULL, call_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(user_id,session_id,run_id,round_id,call_id),
      FOREIGN KEY(user_id,session_id,run_id) REFERENCES agent_run_admissions(user_id,session_id,run_id) ON DELETE CASCADE
    );

CREATE TABLE desktop_agent_reflection_jobs (
      user_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      user_message_id INTEGER NOT NULL,
      model_identity TEXT NOT NULL,
      assistant_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      last_error TEXT,
      PRIMARY KEY(user_id,session_id,run_id),
      FOREIGN KEY(user_id,session_id,run_id) REFERENCES agent_run_admissions(user_id,session_id,run_id) ON DELETE CASCADE
    );

CREATE TABLE desktop_im_memory_tombstones (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
      bot_id TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('group','platform-user')),
      scope_id TEXT NOT NULL,
      PRIMARY KEY(owner_id,platform,bot_id,scope_type,scope_id)
    );

CREATE TABLE desktop_imported_im_memory (
    owner_id TEXT NOT NULL, platform TEXT NOT NULL, bot_id TEXT NOT NULL, scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL, filename TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(owner_id,platform,bot_id,scope_type,scope_id,filename)
  );

CREATE TABLE "desktop_agent_memory_documents" (
      user_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('summary', 'daily', 'stance', 'lens', 'memory')),
      body TEXT NOT NULL,
      PRIMARY KEY(user_id, target)
    );

CREATE TABLE desktop_agent_run_models (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL, model_id TEXT NOT NULL,
      PRIMARY KEY(user_id, session_id, run_id),
      FOREIGN KEY(user_id, session_id, run_id)
        REFERENCES agent_run_admissions(user_id, session_id, run_id) ON DELETE CASCADE
    );

CREATE TABLE agent_interaction_bindings (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
      prompt_id INTEGER PRIMARY KEY REFERENCES interaction_prompts(id) ON DELETE CASCADE,
      UNIQUE(user_id, session_id, run_id, interaction_id),
      FOREIGN KEY(user_id, session_id, run_id)
        REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    );

CREATE TABLE desktop_agent_confirmation_intents (
      user_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      intent_id TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL UNIQUE,
      round_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      action TEXT NOT NULL,
      targets_digest TEXT NOT NULL,
      versions_digest TEXT NOT NULL,
      authorization_epoch TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      receipt_id TEXT UNIQUE,
      claimed_at INTEGER,
      CHECK (claimed_at IS NULL OR receipt_id IS NOT NULL),
      PRIMARY KEY (user_id, session_id, run_id, interaction_id),
      FOREIGN KEY (user_id, session_id, run_id)
        REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    );

CREATE TABLE chat_attachments (
      attach_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message_id INTEGER REFERENCES conversation_messages(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      mime TEXT,
      kind TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size >= 0),
      duration REAL,
      img_width INTEGER,
      img_height INTEGER,
      state TEXT NOT NULL CHECK(state IN ('draft','attached')),
      extra TEXT,
      created_at TEXT NOT NULL,
      attached_at TEXT,
      PRIMARY KEY(user_id,attach_id),
      CHECK(length(attach_id)=32 AND attach_id NOT GLOB '*[^0-9a-f]*'),
      CHECK(storage_key='agent-attachments/' || attach_id)
    );

CREATE TABLE desktop_im_inbox (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
      connection_id TEXT NOT NULL CHECK(length(connection_id) > 0),
      event_key TEXT NOT NULL CHECK(length(event_key) > 0),
      sealed_event BLOB NOT NULL CHECK(length(sealed_event) > 0),
      received_at TEXT NOT NULL,
      session_id INTEGER,
      run_id TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','rejected')),
      PRIMARY KEY(owner_id,platform,connection_id,event_key),
      CHECK((session_id IS NULL) = (run_id IS NULL)),
      CHECK(state NOT IN ('running','completed') OR run_id IS NOT NULL)
    );

CREATE TABLE desktop_im_sessions (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
      connection_id TEXT NOT NULL,
      session_id INTEGER NOT NULL UNIQUE,
      PRIMARY KEY(owner_id,platform,connection_id),
      FOREIGN KEY(session_id,owner_id) REFERENCES conversation_sessions(id,user_id) ON DELETE CASCADE
    );

CREATE TABLE desktop_im_delivery (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('sending','accepted','rejected','unknown')),
      PRIMARY KEY(owner_id,platform,connection_id,event_key),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );

CREATE TABLE desktop_im_notices (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      notice_key TEXT NOT NULL CHECK(length(notice_key) = 64),
      state TEXT NOT NULL CHECK(state IN ('sending','accepted','rejected','unknown')),
      PRIMARY KEY(owner_id,platform,connection_id,event_key,notice_key),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );

CREATE TABLE desktop_im_prompts (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      prompt_id INTEGER NOT NULL REFERENCES interaction_prompts(id) ON DELETE CASCADE,
      message_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('sending','accepted','unknown')),
      PRIMARY KEY(owner_id,platform,connection_id,prompt_id),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE,
      CHECK((state='accepted') = (message_id IS NOT NULL))
    );

CREATE TABLE desktop_qq_sequences (
      sequence_key TEXT PRIMARY KEY,
      value INTEGER NOT NULL CHECK(value > 0),
      expires_ms INTEGER NOT NULL
    );

CREATE TABLE desktop_im_projections (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      sealed_state BLOB NOT NULL,
      PRIMARY KEY(owner_id,platform,connection_id,event_key),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );

CREATE TABLE desktop_im_projection_receipts (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
      state TEXT NOT NULL CHECK(state IN ('sending','accepted','rejected','unknown')),
      PRIMARY KEY(owner_id,platform,connection_id,event_key,operation_key),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_projections(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );

CREATE TABLE desktop_agent_credential_intents (
      user_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      configuration_version TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, session_id, run_id, interaction_id),
      FOREIGN KEY (user_id, session_id, run_id)
        REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    );

CREATE TABLE desktop_im_reflection_jobs (
      owner_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      user_message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
      platform TEXT NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('owner','group','platform-user')),
      scope_id TEXT NOT NULL,
      model_identity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      last_error TEXT,
      PRIMARY KEY(owner_id,session_id,run_id,scope_type,scope_id),
      FOREIGN KEY(owner_id,session_id,run_id) REFERENCES agent_run_admissions(user_id,session_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );

CREATE TABLE desktop_im_reflection_positions (
      owner_id TEXT NOT NULL, session_id INTEGER NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
      last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
      PRIMARY KEY(owner_id,session_id,scope_type,scope_id),
      FOREIGN KEY(session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
    );

CREATE TABLE desktop_im_reflection_plans (
      owner_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
      through_sequence INTEGER NOT NULL CHECK(through_sequence > 0), payload TEXT,
      PRIMARY KEY(owner_id,session_id,run_id,scope_type,scope_id),
      FOREIGN KEY(owner_id,session_id,run_id,scope_type,scope_id)
        REFERENCES desktop_im_reflection_jobs(owner_id,session_id,run_id,scope_type,scope_id) ON DELETE CASCADE
    );

CREATE TABLE desktop_im_reflection_triggers (
      owner_id TEXT NOT NULL, session_id INTEGER NOT NULL,
      passive_count INTEGER NOT NULL DEFAULT 0 CHECK(passive_count >= 0 AND passive_count < 50),
      requested_sequence INTEGER NOT NULL DEFAULT 0 CHECK(requested_sequence >= 0),
      idle_due_at_ms INTEGER,
      PRIMARY KEY(owner_id,session_id),
      FOREIGN KEY(session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
    );

CREATE TABLE desktop_im_reflection_thresholds (
      owner_id TEXT NOT NULL, session_id INTEGER NOT NULL,
      through_sequence INTEGER NOT NULL CHECK(through_sequence > 0), due_at_ms INTEGER NOT NULL,
      PRIMARY KEY(owner_id,session_id,through_sequence),
      FOREIGN KEY(session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE
    );

CREATE TABLE desktop_im_accepted_facts (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('feishu','telegram')),
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
      platform_message_id TEXT NOT NULL CHECK(length(platform_message_id) BETWEEN 1 AND 512),
      recipient_sender_id TEXT NOT NULL CHECK(length(recipient_sender_id) BETWEEN 1 AND 256),
      sent_at_ms INTEGER NOT NULL CHECK(sent_at_ms > 0),
      source_attention_kind TEXT CHECK(source_attention_kind IS NULL OR source_attention_kind IN
        ('DIRECT','member_CONTINUE','CAPABILITY_ACTION','member_ACTIVE','proactive','autonomous')),
      PRIMARY KEY(owner_id,platform,connection_id,event_key,platform_message_id),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );

CREATE TABLE agent_subagent_deliveries (
  owner_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  child_run_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','partial','failed','cancelled')),
  updated_at TEXT NOT NULL,
  nonce BLOB,
  payload BLOB,
  consumed_checkpoint_version BIGINT,
  PRIMARY KEY(owner_id,parent_session_id,parent_run_id,child_id),
  UNIQUE(owner_id,parent_session_id,parent_run_id,call_id),
  CHECK ((nonce IS NULL AND payload IS NULL) OR (nonce IS NOT NULL AND payload IS NOT NULL))
);

CREATE TABLE agent_subagent_sessions (
  child_run_id TEXT PRIMARY KEY,
  child_session_id INTEGER NOT NULL UNIQUE REFERENCES conversation_sessions(id) ON DELETE CASCADE
);

CREATE TABLE agent_subagent_conversations (
  owner_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  child_session_id INTEGER NOT NULL UNIQUE REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  current_run_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (owner_id,parent_session_id,child_id)
);

CREATE TABLE agent_subagent_launches (
  child_run_id TEXT PRIMARY KEY REFERENCES agent_subagent_sessions(child_run_id) ON DELETE CASCADE,
  nonce BLOB NOT NULL,
  payload BLOB NOT NULL
);

CREATE TABLE agent_subagent_continuations (
  child_run_id TEXT PRIMARY KEY,
  child_session_id INTEGER NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  nonce BLOB NOT NULL,
  payload BLOB NOT NULL
);

CREATE TABLE agent_subagent_executions (
  child_run_id TEXT PRIMARY KEY,
  child_session_id INTEGER NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  nonce BLOB,
  payload BLOB,
  CHECK ((nonce IS NULL AND payload IS NULL) OR (nonce IS NOT NULL AND payload IS NOT NULL))
);

CREATE TABLE agent_subagent_waits (
  owner_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  PRIMARY KEY(owner_id, parent_session_id, parent_run_id),
  FOREIGN KEY(owner_id, parent_session_id, parent_run_id, child_id)
    REFERENCES agent_subagent_deliveries(owner_id, parent_session_id, parent_run_id, child_id) ON DELETE CASCADE
);

CREATE TABLE agent_inbox_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  sender_session_id TEXT NOT NULL,
  sender_run_id TEXT NOT NULL,
  recipient_session_id TEXT NOT NULL,
  recipient_run_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  nonce BLOB NOT NULL,
  payload BLOB NOT NULL,
  consumed_checkpoint_version BIGINT,
  UNIQUE(owner_id,sender_session_id,sender_run_id,call_id)
);

CREATE TABLE agent_inbox_waits (
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY(owner_id,session_id,run_id)
);

CREATE TABLE desktop_agent_continuations (
      user_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      reference TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      nonce BLOB NOT NULL,
      payload BLOB NOT NULL,
      PRIMARY KEY (user_id,session_id,run_id),
      FOREIGN KEY (user_id,session_id,run_id)
        REFERENCES agent_run_checkpoints(user_id,session_id,run_id) ON DELETE CASCADE
    );

CREATE INDEX ix_projects_user_id ON projects(user_id);

CREATE INDEX ix_projects_deleted_at ON projects(deleted_at);

CREATE INDEX ix_clients_user_id ON clients(user_id);

CREATE INDEX ix_undo_operations_context_status_created ON undo_operations(user_id,undo_context_id,status,created_at);

CREATE INDEX ix_undo_operations_group ON undo_operations(user_id,group_id);

CREATE INDEX ix_mind_nodes_user_id ON mind_nodes(user_id);

CREATE INDEX ix_mind_nodes_captured_at ON mind_nodes(captured_at);

CREATE INDEX ix_mind_nodes_deleted_at ON mind_nodes(deleted_at);

CREATE INDEX ix_mind_maps_user_id ON mind_maps(user_id);

CREATE INDEX ix_mind_maps_deleted_at ON mind_maps(deleted_at);

CREATE INDEX ix_calendar_events_user_id ON calendar_events(user_id);

CREATE INDEX ix_calendar_events_deleted_at ON calendar_events(deleted_at);

CREATE INDEX ix_rag_index_jobs_user_id ON rag_index_jobs(user_id);

CREATE INDEX ix_rag_index_jobs_due ON rag_index_jobs(status,next_attempt_at);

CREATE INDEX ix_knowledge_index_entries_owner_user_id ON knowledge_index_entries(owner_user_id);

CREATE INDEX ix_knowledge_index_entries_source_type ON knowledge_index_entries(source_type);

CREATE INDEX ix_knowledge_index_entries_source_id ON knowledge_index_entries(source_id);

CREATE INDEX ix_knowledge_index_entries_scope_type ON knowledge_index_entries(scope_type);

CREATE INDEX ix_knowledge_index_entries_scope_id ON knowledge_index_entries(scope_id);

CREATE INDEX ix_knowledge_index_entries_document_id ON knowledge_index_entries(document_id);

CREATE INDEX ix_knowledge_index_entries_content_hash ON knowledge_index_entries(content_hash);

CREATE INDEX ix_knowledge_index_entries_indexed_at ON knowledge_index_entries(indexed_at);

CREATE INDEX ix_knowledge_index_entries_deleted_at ON knowledge_index_entries(deleted_at);

CREATE INDEX ix_knowledge_index_scope_source ON knowledge_index_entries(owner_user_id,scope_type,scope_id,source_type);

CREATE INDEX ix_knowledge_index_owner_source_indexed ON knowledge_index_entries(owner_user_id,source_type,indexed_at);

CREATE INDEX ix_mind_canvas_items_user_id ON mind_canvas_items(user_id);

CREATE INDEX ix_mind_canvas_items_canvas_id ON mind_canvas_items(canvas_id);

CREATE INDEX ix_mind_canvas_items_node_id ON mind_canvas_items(node_id);

CREATE INDEX ix_mind_canvas_items_deleted_at ON mind_canvas_items(deleted_at);

CREATE INDEX ix_mind_relations_user_id ON mind_relations(user_id);

CREATE INDEX ix_mind_relations_canvas_id ON mind_relations(canvas_id);

CREATE INDEX ix_mind_relations_src_node_id ON mind_relations(src_node_id);

CREATE INDEX ix_mind_relations_dst_node_id ON mind_relations(dst_node_id);

CREATE INDEX ix_mind_relations_deleted_at ON mind_relations(deleted_at);

CREATE UNIQUE INDEX uq_mind_relation_legacy ON mind_relations(user_id,src_node_id,dst_node_id,rel_type,edge_key) WHERE canvas_id IS NULL;

CREATE INDEX ix_scheduled_tasks_user_id ON scheduled_tasks(user_id);

CREATE INDEX ix_scheduled_tasks_event_id ON scheduled_tasks(event_id);

CREATE INDEX ix_scheduled_tasks_workspace_id ON scheduled_tasks(workspace_id);

CREATE INDEX ix_scheduled_tasks_filesystem_authorization_grant_id ON scheduled_tasks(filesystem_authorization_grant_id);

CREATE INDEX ix_scheduled_tasks_schedule_kind ON scheduled_tasks(schedule_kind);

CREATE INDEX ix_scheduled_tasks_end_at ON scheduled_tasks(end_at);

CREATE UNIQUE INDEX uq_scheduled_tasks_event_fire ON scheduled_tasks(user_id,event_id,cron) WHERE event_id IS NOT NULL;

CREATE INDEX ix_notification_reads_user_id ON notification_reads(user_id);

CREATE INDEX ix_notification_reads_notification_id ON notification_reads(notification_id);

CREATE INDEX ix_notification_dismissals_user_id ON notification_dismissals(user_id);

CREATE INDEX ix_notification_dismissals_notification_id ON notification_dismissals(notification_id);

CREATE INDEX ix_user_smtp_configs_enabled ON user_smtp_configs(enabled);

CREATE INDEX ix_user_mcp_servers_user_id ON user_mcp_servers(user_id);

CREATE UNIQUE INDEX uq_core_runtime_meta_key_value ON core_runtime_meta(key,value);

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

CREATE UNIQUE INDEX uq_conversation_sessions_id_owner ON conversation_sessions(id,user_id);

CREATE INDEX ix_conversation_batches_session_id ON conversation_batches(session_id);

CREATE INDEX ix_conversation_batches_session_round ON conversation_batches(session_id,round_id);

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

CREATE INDEX ix_conversation_pending_queues_user_id ON conversation_pending_queues(user_id);

CREATE INDEX ix_conversation_pending_queues_session_id ON conversation_pending_queues(session_id);

CREATE INDEX ix_interaction_prompts_user_id ON interaction_prompts(user_id);

CREATE INDEX ix_interaction_prompts_session_id ON interaction_prompts(session_id);

CREATE INDEX ix_interaction_prompts_status ON interaction_prompts(status);

CREATE INDEX ix_interaction_prompts_expires_at ON interaction_prompts(expires_at);

CREATE INDEX ix_interaction_actions_prompt_id ON interaction_actions(prompt_id);

CREATE INDEX ix_interaction_actions_token_hash ON interaction_actions(token_hash);

CREATE INDEX ix_interaction_actions_status ON interaction_actions(status);

CREATE INDEX ix_interaction_actions_expires_at ON interaction_actions(expires_at);

CREATE INDEX ix_agent_run_checkpoints_retention
      ON agent_run_checkpoints(status, updated_at_ms);

CREATE INDEX ix_agent_run_events_retention
      ON agent_run_events(created_at_ms);

CREATE INDEX desktop_agent_reflection_jobs_pending
      ON desktop_agent_reflection_jobs(user_id,session_id,status,created_at_ms);

CREATE INDEX ix_chat_attachments_owner_state ON chat_attachments(user_id,state);

CREATE INDEX ix_chat_attachments_message ON chat_attachments(user_id,message_id);

CREATE INDEX ix_desktop_im_inbox_recovery
      ON desktop_im_inbox(owner_id,received_at) WHERE state IN ('pending','running');

CREATE INDEX ix_desktop_qq_sequences_expiry ON desktop_qq_sequences(expires_ms);

CREATE INDEX desktop_im_reflection_jobs_pending
      ON desktop_im_reflection_jobs(owner_id,session_id,status,created_at_ms);

CREATE INDEX ix_desktop_im_accepted_facts_scope_time
      ON desktop_im_accepted_facts(owner_id,platform,connection_id,sent_at_ms);

CREATE INDEX agent_inbox_pending ON agent_inbox_messages(owner_id,recipient_session_id,recipient_run_id,sequence)
  WHERE consumed_checkpoint_version IS NULL;

CREATE INDEX agent_subagent_session_unread
  ON agent_subagent_deliveries(owner_id,parent_session_id,updated_at,child_run_id)
  WHERE consumed_checkpoint_version IS NULL AND payload IS NOT NULL;

CREATE INDEX agent_inbox_session_unread
  ON agent_inbox_messages(owner_id,recipient_session_id,sequence)
  WHERE consumed_checkpoint_version IS NULL;

CREATE VIEW agent_subagent_execution_sessions AS
  SELECT child_run_id,child_session_id FROM agent_subagent_sessions
  UNION ALL SELECT child_run_id,child_session_id FROM agent_subagent_continuations;

CREATE VIEW agent_subagent_execution_launches AS
  SELECT child_run_id,nonce,payload FROM agent_subagent_launches
  UNION ALL SELECT child_run_id,nonce,payload FROM agent_subagent_continuations;

CREATE TRIGGER validate_user_mcp_servers_owner_insert BEFORE INSERT ON user_mcp_servers WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_user_mcp_servers_owner_update BEFORE UPDATE ON user_mcp_servers WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_user_mcp_tool_schema_snapshots_owner_insert BEFORE INSERT ON user_mcp_tool_schema_snapshots WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_user_mcp_tool_schema_snapshots_owner_update BEFORE UPDATE ON user_mcp_tool_schema_snapshots WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_smtp_owner_insert BEFORE INSERT ON user_smtp_configs WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_smtp_owner_update BEFORE UPDATE ON user_smtp_configs WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_onboarding_owner_insert BEFORE INSERT ON onboarding_state WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_onboarding_owner_update BEFORE UPDATE ON onboarding_state WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_feedback_owner_insert BEFORE INSERT ON feedbacks WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_feedback_owner_update BEFORE UPDATE ON feedbacks WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_preferences_owner_insert BEFORE INSERT ON user_preferences WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_preferences_owner_update BEFORE UPDATE ON user_preferences WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_conversation_sessions_owner_insert BEFORE INSERT ON conversation_sessions WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_conversation_sessions_owner_update BEFORE UPDATE ON conversation_sessions WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_conversation_pending_queues_owner_insert BEFORE INSERT ON conversation_pending_queues WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_conversation_pending_queues_owner_update BEFORE UPDATE ON conversation_pending_queues WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id') BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_message_batch_insert BEFORE INSERT ON conversation_messages WHEN NEW.canonical_batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation_batches WHERE id=NEW.canonical_batch_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT, '消息批次与会话不匹配'); END;

CREATE TRIGGER validate_message_batch_update BEFORE UPDATE OF canonical_batch_id,session_id ON conversation_messages WHEN NEW.canonical_batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation_batches WHERE id=NEW.canonical_batch_id AND session_id=NEW.session_id) BEGIN SELECT RAISE(ABORT, '消息批次与会话不匹配'); END;

CREATE TRIGGER validate_batch_session_update BEFORE UPDATE OF session_id ON conversation_batches WHEN EXISTS (SELECT 1 FROM conversation_messages WHERE canonical_batch_id=OLD.id AND session_id<>NEW.session_id) BEGIN SELECT RAISE(ABORT, '消息批次与会话不匹配'); END;

CREATE TRIGGER protect_core_owner_update BEFORE UPDATE ON core_runtime_meta WHEN OLD.key='owner_id' BEGIN SELECT RAISE(ABORT, 'owner 不可修改'); END;

CREATE TRIGGER protect_core_owner_delete BEFORE DELETE ON core_runtime_meta WHEN OLD.key='owner_id' BEGIN SELECT RAISE(ABORT, 'owner 不可删除'); END;

CREATE TRIGGER validate_interaction_prompts_owner_insert
BEFORE INSERT ON interaction_prompts
WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_interaction_prompts_owner_update
BEFORE UPDATE ON interaction_prompts
WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_chat_attachments_owner_insert
      BEFORE INSERT ON chat_attachments
      WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
      BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_chat_attachments_owner_update
      BEFORE UPDATE OF user_id ON chat_attachments
      WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
      BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_desktop_im_inbox_owner_insert
      BEFORE INSERT ON desktop_im_inbox
      WHEN NEW.owner_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
      BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;

CREATE TRIGGER validate_desktop_im_inbox_owner_update
      BEFORE UPDATE OF owner_id ON desktop_im_inbox
      WHEN NEW.owner_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
      BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;`
