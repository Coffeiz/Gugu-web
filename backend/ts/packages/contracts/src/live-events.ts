/** Web/IM/Agent 共用的业务实时事件契约。 */

import type { JsonValue } from "./protocol.ts";

export const LIVE_EVENT_PROTOCOL_VERSION = "live-event-v1" as const;

export const LIVE_RESOURCES = [
  "projects",
  "calendar",
  "files",
  "mind",
  "scheduled_tasks",
  "sessions",
  "clients",
  "im_channels",
  "terminals",
] as const;

export type LiveResource = (typeof LIVE_RESOURCES)[number];

export const LIVE_OPERATIONS = [
  "create",
  "update",
  "delete",
  "move",
  "append",
  "refresh",
] as const;

export type LiveOperation = (typeof LIVE_OPERATIONS)[number];

export type LiveEventPayload = {
  protocol_version: typeof LIVE_EVENT_PROTOCOL_VERSION;
  event_id: string;
  type: "resource.changed";
  resource: LiveResource;
  operation: LiveOperation;
  entity_id?: string | number | null;
  entity_ids?: Array<string | number>;
  revision: number;
  payload?: JsonValue;
  origin?: string | null;
  created_at: string;
};

export function isLiveResource(value: unknown): value is LiveResource {
  return typeof value === "string" && (LIVE_RESOURCES as readonly string[]).includes(value);
}

export function isLiveOperation(value: unknown): value is LiveOperation {
  return typeof value === "string" && (LIVE_OPERATIONS as readonly string[]).includes(value);
}

/** 只校验 envelope 边界；payload 内容由具体资源 handler 负责解释。 */
export function isLiveEventPayload(value: unknown): value is LiveEventPayload {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return event.protocol_version === LIVE_EVENT_PROTOCOL_VERSION
    && typeof event.event_id === "string"
    && event.event_id.length > 0
    && event.type === "resource.changed"
    && isLiveResource(event.resource)
    && isLiveOperation(event.operation)
    && Number.isSafeInteger(event.revision)
    && typeof event.created_at === "string"
    && !Number.isNaN(Date.parse(event.created_at));
}
