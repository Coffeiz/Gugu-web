import type { DataRuntime } from "./runtime.ts";

export type DataRuntimeResource = "project" | "file" | "conversation" | "knowledge" | "memory" | "canvas" | "all";

export type DataRuntimeInvalidationEvent = {
  eventId?: string;
  ownerId: string;
  resource: DataRuntimeResource;
  scopeType?: "owner";
  scopeId?: string;
  operation: "create" | "update" | "delete" | "permission" | "refresh";
  revision?: string | number;
};

export type DataRuntimeEventSubscription = {
  subscribe(handler: (event: unknown) => void | Promise<void>): () => void;
};

const RESOURCE_ALIASES: Record<string, DataRuntimeResource> = {
  project: "project",
  projects: "project",
  file: "file",
  files: "file",
  conversation: "conversation",
  conversations: "conversation",
  sessions: "conversation",
  knowledge: "knowledge",
  memory: "memory",
  canvas: "canvas",
  all: "all",
};

export function normalizeInvalidationEvent(value: unknown): DataRuntimeInvalidationEvent | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const ownerValue = input.ownerId ?? input.owner_id;
  const resourceValue = input.resource;
  const scopeTypeValue = input.scopeType ?? input.scope_type;
  const scopeIdValue = input.scopeId ?? input.scope_id;
  const ownerId = typeof ownerValue === "string" ? ownerValue.trim() : "";
  const resource = typeof resourceValue === "string" ? RESOURCE_ALIASES[resourceValue] : undefined;
  const operation = typeof input.operation === "string" ? input.operation : "refresh";
  if (!ownerId || !resource || !["create", "update", "delete", "permission", "refresh"].includes(operation)) {
    return null;
  }
  return {
    eventId: typeof input.eventId === "string" ? input.eventId : undefined,
    ownerId,
    resource,
    scopeType: scopeTypeValue === "owner" ? "owner" : undefined,
    scopeId: typeof scopeIdValue === "string" ? scopeIdValue : undefined,
    operation: operation as DataRuntimeInvalidationEvent["operation"],
    revision: typeof input.revision === "string" || typeof input.revision === "number" ? input.revision : undefined,
  };
}

/** 将跨进程业务事件转换为 Data Runtime 的精确缓存失效。 */
export class DataRuntimeInvalidationBridge {
  private unsubscribe?: () => void;

  constructor(private readonly runtime: DataRuntime) {}

  attach(subscription: DataRuntimeEventSubscription): void {
    this.detach();
    this.unsubscribe = subscription.subscribe((payload) => {
      const event = normalizeInvalidationEvent(payload);
      if (event) this.runtime.invalidateForEvent(event);
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
