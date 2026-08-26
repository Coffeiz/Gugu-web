import { strict as assert } from "node:assert";
import test from "node:test";
import {
  LIVE_EVENT_PROTOCOL_VERSION,
  isLiveEventPayload,
  isLiveOperation,
  isLiveResource,
} from "../src/live-events.ts";

test("业务事件契约接受完整的 canonical envelope", () => {
  const event = {
    protocol_version: LIVE_EVENT_PROTOCOL_VERSION,
    event_id: "evt-1",
    type: "resource.changed",
    resource: "files",
    operation: "update",
    entity_id: 123,
    revision: 42,
    payload: { name: "报告.md" },
    origin: "client-1",
    created_at: "2026-08-26T12:00:00.000Z",
  };

  assert.equal(isLiveEventPayload(event), true);
  assert.equal(isLiveResource("files"), true);
  assert.equal(isLiveOperation("update"), true);
});

test("业务事件契约拒绝未知资源、操作和无效版本", () => {
  const base = {
    protocol_version: LIVE_EVENT_PROTOCOL_VERSION,
    event_id: "evt-2",
    type: "resource.changed",
    resource: "files",
    operation: "update",
    revision: 1,
    created_at: "2026-08-26T12:00:00.000Z",
  };

  assert.equal(isLiveEventPayload({ ...base, resource: "unknown" }), false);
  assert.equal(isLiveEventPayload({ ...base, operation: "sync" }), false);
  assert.equal(isLiveEventPayload({ ...base, revision: 1.5 }), false);
  assert.equal(isLiveEventPayload({ ...base, protocol_version: "legacy" }), false);
});
