import assert from "node:assert/strict";
import test from "node:test";
import { assertOwnerScope } from "../src/contracts.ts";

test("Data Runtime 只接受与 owner 一致的 owner scope", () => {
  assert.equal(assertOwnerScope({ ownerId: "owner-1" }), "owner-1");
  assert.equal(assertOwnerScope({ ownerId: "owner-1", scope: { type: "owner", id: "owner-1" } }), "owner-1");
  assert.throws(
    () => assertOwnerScope({ ownerId: "owner-1", scope: { type: "group", id: "group-1" } }),
    /拒绝未实现的读取范围/,
  );
  assert.throws(() => assertOwnerScope({ ownerId: "" }), /缺少 ownerId/);
});
