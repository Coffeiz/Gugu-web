import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { FileSystemWatcher, type WatchEvent } from "../src/watcher.ts";

const waitFor = async (events: WatchEvent[], predicate: (event: WatchEvent) => boolean): Promise<WatchEvent> => {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("未收到预期文件事件");
};

test("TS watcher 监听文件和文件夹变化，不发送初始扫描事件", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gugu-filesync-ts-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "existing.txt"), "existing");
  const events: WatchEvent[] = [];
  const watcher = new FileSystemWatcher((event) => events.push(event));
  t.after(() => watcher.close());
  await watcher.watchBinding(1, root);
  assert.deepEqual(events.filter((event) => event.event === "change"), []);
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "folder", "created.txt"), "created");
  await waitFor(events, (event) => event.event === "change" && event.relative_path === "folder" && event.object_type === "folder");
  await waitFor(events, (event) => event.event === "change" && event.relative_path === "folder/created.txt" && event.operation === "create");
  await watcher.unwatchBinding(1);
  const count = events.length;
  await writeFile(join(root, "after-unwatch.txt"), "ignored");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(events.length, count);
});

test("TS watcher 仅输出协议事件，不把物理路径写入 error 事件", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gugu-filesync-ts-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events: WatchEvent[] = [];
  const watcher = new FileSystemWatcher((event) => events.push(event));
  t.after(() => watcher.close());
  await watcher.watchBinding(7, root);
  assert.deepEqual(events.at(-1), { protocol: 1, kind: "event", event: "ready", binding_id: 7 });
  assert.equal(events.some((event) => JSON.stringify(event).includes(root)), false);
});
