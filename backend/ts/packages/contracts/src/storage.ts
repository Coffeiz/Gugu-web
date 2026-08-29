/** 持久化与协调存储的职责边界；具体 adapter 在后续 Phase 实现。 */

export type DurableRecord = "user" | "session" | "message" | "tool_event" | "task" | "rag_metadata" | "audit";
export type EphemeralRecord = "command_queue" | "cancel_signal" | "sse_fanout" | "short_lock" | "worker_lease" | "run_snapshot";

export type StorageBoundary = {
  postgres: { owner: "canonical"; records: DurableRecord[] };
  redis: { owner: "ephemeral"; records: EphemeralRecord[]; ttl_required: true };
};

export const STORAGE_BOUNDARY: StorageBoundary = {
  postgres: {
    owner: "canonical",
    records: ["user", "session", "message", "tool_event", "task", "rag_metadata", "audit"],
  },
  redis: {
    owner: "ephemeral",
    records: ["command_queue", "cancel_signal", "sse_fanout", "short_lock", "worker_lease", "run_snapshot"],
    ttl_required: true,
  },
};
