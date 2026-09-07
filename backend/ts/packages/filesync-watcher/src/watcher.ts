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

  constructor(emit: (event: WatchEvent) => void) {
    this.emit = emit;
  }

  async watchBinding(bindingId: number, rootPath: string): Promise<void> {
    const root = resolve(rootPath);
    const current = this.bindings.get(bindingId);
    if (current?.root === root) {
      this.emit({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "ready", binding_id: bindingId });
      return;
    }
    if (current) {
      await current.watcher.close();
      this.bindings.delete(bindingId);
    }

    const watcher = watch(root, {
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
    this.bindings.set(bindingId, { root, watcher });
    const emitChange = (operation: "create" | "update" | "delete", objectType: "file" | "folder") => (path: string) => {
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
    watcher.on("error", () => {
      this.emit({
        protocol: FILESYNC_PROTOCOL_VERSION,
        kind: "event",
        event: "error",
        binding_id: bindingId,
        code: "watcher_error",
      });
    });
    await new Promise<void>((resolveReady) => {
      watcher.once("ready", () => {
        this.emit({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "ready", binding_id: bindingId });
        resolveReady();
      });
    });
  }

  async unwatchBinding(bindingId: number): Promise<void> {
    const binding = this.bindings.get(bindingId);
    if (!binding) return;
    await binding.watcher.close();
    this.bindings.delete(bindingId);
  }

  async close(): Promise<void> {
    await Promise.all([...this.bindings.keys()].map((bindingId) => this.unwatchBinding(bindingId)));
  }
}
