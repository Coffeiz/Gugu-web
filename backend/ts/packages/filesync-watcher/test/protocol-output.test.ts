import assert from "node:assert/strict";
import test from "node:test";
import { BoundedProtocolOutput } from "../src/protocol-output.ts";

test("输出拥塞时保留恢复信号并让命令确认优先于积压路径事件", () => {
  const output = new BoundedProtocolOutput(2, 1);
  output.enqueue({ protocol: 1, kind: "event", event: "change", relative_path: "old-a.txt" });
  output.enqueue({ protocol: 1, kind: "event", event: "change", relative_path: "old-b.txt" });
  output.enqueue({ protocol: 1, kind: "event", event: "change", relative_path: "dropped.txt" });
  output.enqueue({ protocol: 1, kind: "response", id: "watch-1", status: "ok" });

  assert.deepEqual(output.take(), {
    protocol: 1, kind: "event", event: "needs_reconcile", code: "output_overflow",
  });
  assert.deepEqual(output.take(), { protocol: 1, kind: "response", id: "watch-1", status: "ok" });
  assert.deepEqual(output.take(), { protocol: 1, kind: "event", event: "change", relative_path: "old-b.txt" });
  assert.equal(output.take(), null);
});
