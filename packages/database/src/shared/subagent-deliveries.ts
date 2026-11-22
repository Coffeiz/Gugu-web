/** 两端共享的子运行交付记录。正文和模型结果只保存加密负载。 */
export function subagentDeliverySchema(binary: 'bytea' | 'BLOB') {
  return `
CREATE TABLE IF NOT EXISTS agent_subagent_deliveries (
  owner_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  child_run_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','partial','failed','cancelled')),
  updated_at TEXT NOT NULL,
  nonce ${binary},
  payload ${binary},
  consumed_checkpoint_version BIGINT,
  PRIMARY KEY(owner_id,parent_session_id,parent_run_id,child_id),
  UNIQUE(owner_id,parent_session_id,parent_run_id,call_id),
  CHECK ((nonce IS NULL AND payload IS NULL) OR (nonce IS NOT NULL AND payload IS NOT NULL))
);
`
}
