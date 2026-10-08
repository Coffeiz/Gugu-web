import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const FILESYNC_PROTOCOL_VERSION = 1;
export const FILESYNC_MAX_PENDING_OUTPUT = 10_000;

export type WatchEvent = {
  protocol: number;
  kind: "event";
  event: "change" | "ready" | "needs_reconcile" | "error";
  binding_id?: number;
  operation?: "create" | "update" | "delete";
  object_type?: "file" | "folder";
  relative_path?: string;
  code?: string;
};

type Entry = { objectType: "file" | "folder" };
type SharedDirectoryWatcher = { watcher: FSWatcher; subscribers: Set<number> };
type Binding = {
  root: string;
  entries: Map<string, Entry>;
  includedRootEntries?: Set<string>;
  watchedDirectories: Set<string>;
  pending: Set<string>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  ready: boolean;
  initializing: boolean;
  failed: boolean;
  gapReported: boolean;
};

const MAX_BUFFERED_PATHS = 20_000;
const IGNORED_NAMES = [".gugu-sync-"];

function relativePath(root: string, changedPath: string): string | null {
  const value = relative(root, resolve(changedPath)).split(sep).join("/");
  if (!value || value === "." || value.startsWith("../") || value.includes("/../") || value === "..") return null;
  return value;
}

function isIgnored(path: string): boolean {
  return path.split("/").some((part) =>
    IGNORED_NAMES.some((prefix) => part.startsWith(prefix)) || part.endsWith(".gugu-part") || part.endsWith(".gugu-tmp"),
  );
}

function inScope(binding: Binding, path: string): boolean {
  const first = path.split("/", 1)[0];
  return !binding.includedRootEntries || binding.includedRootEntries.has(first);
}

export class FileSystemWatcher {
  private readonly bindings = new Map<number, Binding>();
  private readonly directories = new Map<string, SharedDirectoryWatcher>();
  private readonly emit: (event: WatchEvent) => void;
  private readonly createWatcher: typeof watch;

  constructor(emit: (event: WatchEvent) => void, createWatcher: typeof watch = watch) {
    this.emit = emit;
    this.createWatcher = createWatcher;
  }

  async watchBinding(bindingId: number, rootPath: string, includedRootEntries?: string[]): Promise<void> {
    const root = resolve(rootPath);
    const included = includedRootEntries?.length ? new Set(includedRootEntries) : undefined;
    const current = this.bindings.get(bindingId);
    if (current?.root === root && this.sameScope(current.includedRootEntries, included)) {
      if (current.ready && !current.failed) this.emitReady(bindingId);
      return;
    }
    if (current) await this.unwatchBinding(bindingId);

    const binding: Binding = {
      root,
      entries: new Map(),
      includedRootEntries: included,
      watchedDirectories: new Set(),
      pending: new Set(),
      timers: new Map(),
      ready: false,
      initializing: true,
      failed: false,
      gapReported: false,
    };
    this.bindings.set(bindingId, binding);
    // 命令确认只代表注册受理；目录索引在后台构建，期间事件持续缓冲。
    void this.initialize(bindingId, binding);
  }

  private sameScope(left?: Set<string>, right?: Set<string>): boolean {
    if (!left || !right) return left === right;
    return left.size === right.size && [...left].every((value) => right.has(value));
  }

  private isCurrent(bindingId: number, binding: Binding): boolean {
    return this.bindings.get(bindingId) === binding;
  }

  private emitReady(bindingId: number): void {
    this.emit({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "ready", binding_id: bindingId });
  }

  private reportGap(bindingId: number, binding: Binding, code: string): void {
    if (binding.gapReported || !this.isCurrent(bindingId, binding)) return;
    binding.gapReported = true;
    this.emit({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "needs_reconcile", binding_id: bindingId, code });
  }

  private emitError(bindingId: number, binding: Binding, code: string): void {
    if (!this.isCurrent(bindingId, binding) || binding.failed) return;
    binding.failed = true;
    this.emit({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "error", binding_id: bindingId, code });
  }

  private watchDirectory(bindingId: number, binding: Binding, directory: string): void {
    const absolute = resolve(directory);
    if (binding.watchedDirectories.has(absolute)) return;
    const shared = this.directories.get(absolute);
    if (shared) {
      shared.subscribers.add(bindingId);
      binding.watchedDirectories.add(absolute);
      return;
    }
    let watcher: FSWatcher;
    try {
      watcher = this.createWatcher(absolute, (eventType, filename) => {
        const current = this.directories.get(absolute);
        if (!current) return;
        for (const subscriberId of [...current.subscribers]) {
          const subscriber = this.bindings.get(subscriberId);
          if (!subscriber || subscriber.failed) continue;
          if (filename === null) {
            this.reportGap(subscriberId, subscriber, "watcher_filename_unavailable");
            continue;
          }
          const changed = resolve(absolute, String(filename));
          const path = relativePath(subscriber.root, changed);
          if (!path || isIgnored(path) || !inScope(subscriber, path)) continue;
          if (subscriber.initializing) {
            if (subscriber.pending.size >= MAX_BUFFERED_PATHS) {
              this.reportGap(subscriberId, subscriber, "watcher_event_buffer_overflow");
              continue;
            }
            subscriber.pending.add(path);
            continue;
          }
          this.schedulePath(subscriberId, subscriber, path, eventType);
        }
      });
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      this.emitError(bindingId, binding, errno.code === "ENOSPC" ? "watcher_limit_exceeded" : "watcher_error");
      return;
    }
    const registration: SharedDirectoryWatcher = { watcher, subscribers: new Set([bindingId]) };
    this.directories.set(absolute, registration);
    binding.watchedDirectories.add(absolute);
    watcher.on("error", (error: NodeJS.ErrnoException) => {
      if (this.directories.get(absolute) !== registration) return;
      this.directories.delete(absolute);
      for (const subscriberId of [...registration.subscribers]) {
        const subscriber = this.bindings.get(subscriberId);
        if (!subscriber) continue;
        subscriber.watchedDirectories.delete(absolute);
        this.emitError(subscriberId, subscriber, error.code === "ENOSPC" ? "watcher_limit_exceeded" : "watcher_error");
      }
    });
  }

  private releaseDirectory(bindingId: number, binding: Binding, directory: string): void {
    const absolute = resolve(directory);
    if (!binding.watchedDirectories.delete(absolute)) return;
    const shared = this.directories.get(absolute);
    if (!shared) return;
    shared.subscribers.delete(bindingId);
    if (shared.subscribers.size === 0) {
      this.directories.delete(absolute);
      shared.watcher.close();
    }
  }

  private async initialize(bindingId: number, binding: Binding): Promise<void> {
    try {
      await this.scanDirectory(bindingId, binding, "");
      if (!this.isCurrent(bindingId, binding) || binding.failed) return;
      binding.initializing = false;
      const changedDuringScan = [...binding.pending];
      binding.pending.clear();
      for (const path of changedDuringScan) await this.processPath(bindingId, binding, path, "rename");
      if (!binding.failed && !binding.gapReported && this.isCurrent(bindingId, binding)) {
        binding.ready = true;
        this.emitReady(bindingId);
      }
    } catch {
      if (this.isCurrent(bindingId, binding)) this.emitError(bindingId, binding, "watcher_scan_failed");
    }
  }

  private async scanDirectory(bindingId: number, binding: Binding, prefix: string): Promise<void> {
    if (!this.isCurrent(bindingId, binding) || binding.failed) return;
    const directory = prefix ? resolve(binding.root, prefix) : binding.root;
    this.watchDirectory(bindingId, binding, directory);
    if (binding.failed) return;
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw error;
    }
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (isIgnored(path) || (prefix === "" && binding.includedRootEntries && !binding.includedRootEntries.has(path)) || child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        binding.entries.set(path, { objectType: "folder" });
        await this.scanDirectory(bindingId, binding, path);
      } else if (child.isFile()) {
        binding.entries.set(path, { objectType: "file" });
      }
    }
  }

  private schedulePath(bindingId: number, binding: Binding, path: string, eventType: string): void {
    const existing = binding.timers.get(path);
    if (existing) clearTimeout(existing);
    const delay = eventType === "change" ? 300 : 80;
    binding.timers.set(path, setTimeout(() => {
      binding.timers.delete(path);
      void this.processPath(bindingId, binding, path, eventType);
    }, delay));
  }

  private async processPath(bindingId: number, binding: Binding, path: string, _eventType: string): Promise<void> {
    if (!this.isCurrent(bindingId, binding) || binding.failed) return;
    const absolute = resolve(binding.root, path);
    try {
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        // 符号链接不是文件库支持的对象，目录初始索引也会跳过它们。
        // 新出现的链接应保持在同步范围外；只有它替换了已追踪的普通对象时，
        // 才需要报告缺口，避免 node_modules/.bin 等生成链接持续降级绑定。
        if (binding.entries.has(path)) {
          this.reportGap(bindingId, binding, "watcher_symlink_changed");
        }
        return;
      }
      if (stats.isDirectory()) {
        const before = new Set(binding.entries.keys());
        binding.entries.set(path, { objectType: "folder" });
        await this.scanDirectory(bindingId, binding, path);
        for (const [foundPath, entry] of binding.entries) {
          if (!before.has(foundPath) && (foundPath === path || foundPath.startsWith(`${path}/`))) {
            this.emitChange(bindingId, "create", entry.objectType, foundPath);
          }
        }
        return;
      }
      if (!stats.isFile()) return;
      // 给正在写入的文件一个稳定窗口，只读取元信息，不读取文件正文。
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      const stable = await lstat(absolute);
      if (!stable.isFile() || stable.isSymbolicLink()) {
        this.reportGap(bindingId, binding, "watcher_path_changed_during_write");
        return;
      }
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent && !binding.entries.has(parent)) {
        const before = new Set(binding.entries.keys());
        await this.scanDirectory(bindingId, binding, parent);
        for (const [foundPath, entry] of binding.entries) {
          if (!before.has(foundPath) && (foundPath === parent || foundPath.startsWith(`${parent}/`))) {
            this.emitChange(bindingId, "create", entry.objectType, foundPath);
          }
        }
        return;
      }
      const previous = binding.entries.get(path);
      binding.entries.set(path, { objectType: "file" });
      this.emitChange(bindingId, previous ? "update" : "create", "file", path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.reportGap(bindingId, binding, "watcher_path_unavailable");
        return;
      }
      const removed = [...binding.entries.keys()].filter((entry) => entry === path || entry.startsWith(`${path}/`));
      if (!removed.length) return;
      for (const entry of removed) {
        const previous = binding.entries.get(entry)!;
        binding.entries.delete(entry);
        this.emitChange(bindingId, "delete", previous.objectType, entry);
      }
      for (const directory of [...binding.watchedDirectories]) {
        if (directory === absolute || directory.startsWith(`${absolute}${sep}`)) this.releaseDirectory(bindingId, binding, directory);
      }
    }
  }

  private emitChange(bindingId: number, operation: "create" | "update" | "delete", objectType: "file" | "folder", path: string): void {
    this.emit({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "change", binding_id: bindingId,
      operation, object_type: objectType, relative_path: path });
  }

  async unwatchBinding(bindingId: number): Promise<void> {
    const binding = this.bindings.get(bindingId);
    if (!binding) return;
    this.bindings.delete(bindingId);
    for (const timer of binding.timers.values()) clearTimeout(timer);
    binding.timers.clear();
    for (const directory of [...binding.watchedDirectories]) this.releaseDirectory(bindingId, binding, directory);
  }

  async close(): Promise<void> {
    await Promise.all([...this.bindings.keys()].map((bindingId) => this.unwatchBinding(bindingId)));
  }
}
