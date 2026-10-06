import { relative, resolve } from "node:path";
import { watch, type FSWatcher } from "chokidar";

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

type Binding = {
  root: string;
  watcher: FSWatcher;
  ready: boolean;
  failed: boolean;
};

function relativePath(root: string, changedPath: string): string | null {
  const value = relative(root, resolve(changedPath)).split("\\").join("/");
  if (!value || value === "." || value.startsWith("../") || value.includes("/../") || value === "..") {
    return null;
  }
  return value;
}

export class FileSystemWatcher {
  private readonly bindings = new Map<number, Binding>();
  private readonly emit: (event: WatchEvent) => void;
  private readonly createWatcher: typeof watch;

  constructor(emit: (event: WatchEvent) => void, createWatcher: typeof watch = watch) {
    this.emit = emit;
    this.createWatcher = createWatcher;
  }

  async watchBinding(bindingId: number, rootPath: string): Promise<void> {
    const root = resolve(rootPath);
    const current = this.bindings.get(bindingId);
    if (current?.root === root) {
      if (current.ready && !current.failed) {
        this.emit({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "ready", binding_id: bindingId });
      }
      return;
    }
    if (current) {
      this.bindings.delete(bindingId);
      await current.watcher.close();
    }

    const watcher = this.createWatcher(root, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 50,
      },
      ignored: (path) => {
        const name = String(path).split(/[\\/]/u).pop() ?? "";
        return name.startsWith(".gugu-sync-") || name.endsWith(".gugu-part") || name.endsWith(".gugu-tmp");
      },
    });
    const binding: Binding = { root, watcher, ready: false, failed: false };
    this.bindings.set(bindingId, binding);
    const isCurrent = () => this.bindings.get(bindingId) === binding;
    const emitChange = (operation: "create" | "update" | "delete", objectType: "file" | "folder") => (path: string) => {
      if (!isCurrent()) return;
      const relative = relativePath(root, path);
      if (!relative) return;
      this.emit({
        protocol: FILESYNC_PROTOCOL_VERSION,
        kind: "event",
        event: "change",
        binding_id: bindingId,
        operation,
        object_type: objectType,
        relative_path: relative,
      });
    };
    watcher.on("add", emitChange("create", "file"));
    watcher.on("change", emitChange("update", "file"));
    watcher.on("unlink", emitChange("delete", "file"));
    watcher.on("addDir", emitChange("create", "folder"));
    watcher.on("unlinkDir", emitChange("delete", "folder"));
    watcher.on("error", (error: NodeJS.ErrnoException) => {
      if (!isCurrent()) return;
      binding.failed = true;
      this.emit({
        protocol: FILESYNC_PROTOCOL_VERSION,
        kind: "event",
        event: "error",
        binding_id: bindingId,
        code: error.code === "ENOSPC" ? "watcher_limit_exceeded" : "watcher_error",
      });
    });
    // 命令确认只代表注册受理；初始遍历不能阻塞后续命令或事件消费。
    watcher.once("ready", () => {
      if (!isCurrent() || binding.failed) return;
      binding.ready = true;
      this.emit({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "ready", binding_id: bindingId });
    });
  }

  async unwatchBinding(bindingId: number): Promise<void> {
    const binding = this.bindings.get(bindingId);
    if (!binding) return;
    this.bindings.delete(bindingId);
    await binding.watcher.close();
  }

  async close(): Promise<void> {
    await Promise.all([...this.bindings.keys()].map((bindingId) => this.unwatchBinding(bindingId)));
  }
}
