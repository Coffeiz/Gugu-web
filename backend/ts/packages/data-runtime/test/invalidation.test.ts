import assert from "node:assert/strict";
import test from "node:test";
import { DataRuntimeInvalidationBridge, normalizeInvalidationEvent } from "../src/invalidation.ts";

test("Data Runtime 归一化 Python 业务来源事件", () => {
  assert.deepEqual(normalizeInvalidationEvent({
    owner_id: "owner-1",
    resource: "projects",
    operation: "update",
    revision: 4,
  }), {
    eventId: undefined,
    ownerId: "owner-1",
    resource: "project",
    scopeType: undefined,
    scopeId: undefined,
    operation: "update",
    revision: 4,
  });
  assert.equal(normalizeInvalidationEvent({ ownerId: "owner-1", resource: "unknown" }), null);
});

test("Data Runtime invalidation bridge 可挂载和解除订阅", () => {
  const handlers: Array<(event: unknown) => void> = [];
  const invalidated: unknown[] = [];
  const runtime = { invalidateForEvent: (event: unknown) => invalidated.push(event) } as never;
  const bridge = new DataRuntimeInvalidationBridge(runtime);
  bridge.attach({ subscribe: (handler) => {
    handlers.push(handler);
    return () => undefined;
  }});
  assert.equal(handlers.length, 1);
  void handlers[0]({ owner_id: "owner-1", resource: "files", operation: "delete" });
  assert.equal(invalidated.length, 1);
  bridge.detach();
});
