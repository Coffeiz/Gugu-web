/** API、Worker 与旧 Python backend 之间共用的运行时协议。 */

export const PROTOCOL_VERSION = "protocol-v1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SessionRef = { session_id: string; owner_id: string };
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
};

export type Message = SessionRef & {
  message_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  usage?: Usage;
};

export type ToolCall = {
  call_id: string;
  name: string;
  arguments: Record<string, JsonValue>;
};

export type ToolResult = {
  call_id: string;
  name: string;
  ok: boolean;
  output?: JsonValue;
  error?: ErrorInfo;
};

export type ErrorInfo = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, JsonValue>;
};

export type CommandName = "agent.run" | "agent.cancel" | "message.create" | "tool.execute";
export type CommandPayload = {
  "agent.run": { session: SessionRef; message: Message; tool_calls?: ToolCall[] };
  "agent.cancel": { run_id: string; reason?: string };
  "message.create": { message: Message };
  "tool.execute": { session: SessionRef; call: ToolCall };
};

export type CommandEnvelope<N extends CommandName = CommandName> = {
  protocol_version: typeof PROTOCOL_VERSION;
  command_id: string;
  name: N;
  run_id?: string;
  created_at: string;
  payload: CommandPayload[N];
};

export type EventName = "run.started" | "run.delta" | "run.completed" | "run.failed" | "tool.result" | "message.created";
export type EventPayload = {
  "run.started": { session: SessionRef };
  "run.delta": { text: string };
  "run.completed": { status: "completed"; usage?: Usage; message?: Message };
  "run.failed": { status: "failed"; error: ErrorInfo };
  "tool.result": { result: ToolResult };
  "message.created": { message: Message };
};

export type EventEnvelope<N extends EventName = EventName> = {
  protocol_version: typeof PROTOCOL_VERSION;
  event_id: string;
  name: N;
  run_id?: string;
  occurred_at: string;
  payload: EventPayload[N];
};
