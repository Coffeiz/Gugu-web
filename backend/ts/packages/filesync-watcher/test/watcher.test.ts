import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { watch as nativeWatch, type FSWatcher, type WatchOptions, type WatchListener } from "node:fs";
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

test("递归目录 watcher 跟踪创建、等长修改和删除，不发送初始扫描事件", async (t) => {
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
  await writeFile(join(root, "folder", "created.txt"), "first");
  await waitFor(events, (event) => event.event === "change" && event.relative_path === "folder" && event.object_type === "folder");
  await waitFor(events, (event) => event.event === "change" && event.relative_path === "folder/created.txt" && event.operation === "create");
  await writeFile(join(root, "folder", "created.txt"), "other");
  await waitFor(events, (event) => event.event === "change" && event.relative_path === "folder/created.txt" && event.operation === "update");
  await rm(join(root, "folder"), { recursive: true });
  await waitFor(events, (event) => event.event === "change" && event.relative_path === "folder/created.txt" && event.operation === "delete");
  await waitFor(events, (event) => event.event === "change" && event.relative_path === "folder" && event.operation === "delete");

  await watcher.unwatchBinding(1);
  const count = events.length;
  await writeFile(join(root, "after-unwatch.txt"), "ignored");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(events.length, count);
});

test("用户根 binding 只索引允许的 File 库顶层目录", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gugu-filesync-ts-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "个人文件"));
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "workspace", "ignored.txt"), "old");
  const events: WatchEvent[] = [];
  const watcher = new FileSystemWatcher((event) => events.push(event));
  t.after(() => watcher.close());
  await watcher.watchBinding(9, root, ["个人文件", "项目文件"]);
  await waitFor(events, (event) => event.event === "ready");
  await writeFile(join(root, "workspace", "ignored.txt"), "new");
  await mkdir(join(root, "个人文件", "notes"));
  await waitFor(events, (event) => event.event === "change" && event.relative_path === "个人文件/notes");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(events.some((event) => event.relative_path?.startsWith("workspace/")), false);
});

test("递归目录 watcher 不跟随符号链接进入文件库扫描范围之外", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gugu-filesync-ts-root-"));
  const outside = await mkdtemp(join(tmpdir(), "gugu-filesync-ts-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await symlink(outside, join(root, "linked-directory"), "dir");

  const events: WatchEvent[] = [];
  const watcher = new FileSystemWatcher((event) => events.push(event));
  t.after(() => watcher.close());
  await watcher.watchBinding(8, root);
  await waitFor(events, (event) => event.event === "ready");

  await writeFile(join(outside, "outside.txt"), "outside");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(events.filter((event) => event.event === "change"), []);
});

test("新建的未登记符号链接不制造同步缺口，但替换已追踪文件仍需核对", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gugu-filesync-ts-symlink-event-"));
  const outside = await mkdtemp(join(tmpdir(), "gugu-filesync-ts-symlink-target-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(join(root, "tracked.txt"), "tracked");
  await writeFile(join(outside, "target.txt"), "target");

  const source = Object.assign(new EventEmitter(), { close: () => {} }) as unknown as FSWatcher;
  let listener: WatchListener<string> | undefined;
  const createWatcher = ((_path: string, options: WatchOptions | WatchListener<string>, onEvent?: WatchListener<string>) => {
    listener = typeof options === "function" ? options : onEvent;
    return source;
  }) as typeof import("node:fs").watch;
  const events: WatchEvent[] = [];
  const watcher = new FileSystemWatcher((event) => events.push(event), createWatcher);
  t.after(() => watcher.close());
  await watcher.watchBinding(12, root);
  await waitFor(events, (event) => event.event === "ready");

  await symlink(join(outside, "target.txt"), join(root, "generated-link"));
  listener?.("rename", "generated-link");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(events.some((event) => event.event === "needs_reconcile"), false);
  assert.equal(events.some((event) => event.event === "change" && event.relative_path === "generated-link"), false);

  await rm(join(root, "tracked.txt"));
  await symlink(join(outside, "target.txt"), join(root, "tracked.txt"));
  listener?.("rename", "tracked.txt");
  await waitFor(events, (event) => event.event === "needs_reconcile" && event.code === "watcher_symlink_changed");
});

test("目录 watcher 不随文件数增加，且同一目录只注册一次", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gugu-filesync-ts-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = Object.assign(new EventEmitter(), { close: () => {} }) as unknown as FSWatcher;
  let listener: WatchListener<string> | undefined;
  let watcherCreations = 0;
  const createWatcher = ((_path: string, options: WatchOptions | WatchListener<string>, onEvent?: WatchListener<string>) => {
    watcherCreations += 1;
    listener = typeof options === "function" ? options : onEvent;
    return source;
  }) as typeof import("node:fs").watch;
  const events: WatchEvent[] = [];
  const watcher = new FileSystemWatcher((event) => events.push(event), createWatcher);
  t.after(() => watcher.close());
  await watcher.watchBinding(10, root);
  await waitFor(events, (event) => event.event === "ready");
  await writeFile(join(root, "probe.txt"), "probe");
  listener?.("rename", "probe.txt");
  await waitFor(events, (event) => event.event === "change" && event.relative_path === "probe.txt" && event.operation === "create");
  assert.equal(watcherCreations, 1);
  assert.equal(await readFile(join(root, "probe.txt"), "utf8"), "probe");
});

test("嵌套 binding 共享物理目录监听并各自收到正确相对路径", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gugu-filesync-ts-shared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = join(root, "nested");
  await mkdir(nested);
  const watchedPaths = new Set<string>();
  const createWatcher = ((path: string, _options: WatchOptions | WatchListener<string>, listener?: WatchListener<string>) => {
    watchedPaths.add(path);
    return nativeWatch(path, { persistent: true }, typeof _options === "function" ? _options : listener!);
  }) as typeof import("node:fs").watch;
  const events: WatchEvent[] = [];
  const watcher = new FileSystemWatcher((event) => events.push(event), createWatcher);
  t.after(() => watcher.close());
  await watcher.watchBinding(20, root);
  await watcher.watchBinding(21, nested);
  await waitFor(events, (event) => event.event === "ready" && event.binding_id === 20);
  await waitFor(events, (event) => event.event === "ready" && event.binding_id === 21);
  assert.equal(watchedPaths.size, 2, "根目录与嵌套目录各监听一次，嵌套目录不重复注册");

  await writeFile(join(nested, "shared.txt"), "change");
  await waitFor(events, (event) => event.event === "change" && event.binding_id === 20 && event.relative_path === "nested/shared.txt");
  await waitFor(events, (event) => event.event === "change" && event.binding_id === 21 && event.relative_path === "shared.txt");
});

test("递归 watcher 建立时遇到 ENOSPC 只标记该 binding 的监听额度错误", async () => {
  const events: WatchEvent[] = [];
  const createWatcher = (() => {
    throw Object.assign(new Error("private path"), { code: "ENOSPC" });
  }) as typeof import("node:fs").watch;
  const watcher = new FileSystemWatcher((event) => events.push(event), createWatcher);
  await watcher.watchBinding(11, "/synthetic/root");
  assert.deepEqual(events, [{ protocol: 1, kind: "event", event: "error", binding_id: 11, code: "watcher_limit_exceeded" }]);
  await watcher.close();
});
