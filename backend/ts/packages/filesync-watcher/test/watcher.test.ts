import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { watch, FSWatcher } from "chokidar";
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
  await waitFor(events, (event) => event.event === "ready");
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
  await waitFor(events, (event) => event.event === "ready");
  assert.deepEqual(events.at(-1), { protocol: 1, kind: "event", event: "ready", binding_id: 7 });
  assert.equal(events.some((event) => JSON.stringify(event).includes(root)), false);
});

test("注册不等待 ready，初始遍历期间创建、等长更新和删除仍输出", async () => {
  const source = new EventEmitter();
  const fake = Object.assign(source, { close: async () => {} }) as unknown as FSWatcher;
  const events: WatchEvent[] = [];
  const watcher = new FileSystemWatcher((event) => events.push(event), (() => fake) as typeof watch);
  await watcher.watchBinding(1, "/synthetic/root");
  await watcher.watchBinding(1, "/synthetic/root");
  assert.equal(events.length, 0, "重复注册不能把尚未就绪伪装成 ready");
  for (const event of ["add", "change", "unlink"]) source.emit(event, "/synthetic/root/item.txt");
  assert.deepEqual(events.map((event) => event.operation), ["create", "update", "delete"]);
  source.emit("ready");
  assert.equal(events.at(-1)?.event, "ready");
  await watcher.unwatchBinding(1);
  const count = events.length;
  source.emit("change", "/synthetic/root/item.txt");
  assert.equal(events.length, count, "解绑后旧回调不得污染新监听");
});

test("监听额度耗尽可见，随后 ready 或重复注册不掩盖失败", async () => {
  const source = new EventEmitter();
  const fake = Object.assign(source, { close: async () => {} }) as unknown as FSWatcher;
  const events: WatchEvent[] = [];
  const watcher = new FileSystemWatcher((event) => events.push(event), (() => fake) as typeof watch);
  await watcher.watchBinding(2, "/synthetic/root");
  source.emit("error", Object.assign(new Error("private path"), { code: "ENOSPC" }));
  source.emit("ready");
  await watcher.watchBinding(2, "/synthetic/root");
  assert.deepEqual(events, [{ protocol: 1, kind: "event", event: "error", binding_id: 2, code: "watcher_limit_exceeded" }]);
  await watcher.close();
});
