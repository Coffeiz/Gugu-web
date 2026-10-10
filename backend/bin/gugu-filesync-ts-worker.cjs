// src/index.ts
var import_node_readline = require("node:readline");

// src/protocol-output.ts
var BoundedProtocolOutput = class {
  queue = [];
  overflowPending = false;
  maximum;
  protocol;
  constructor(maximum, protocol) {
    this.maximum = maximum;
    this.protocol = protocol;
  }
  enqueue(message) {
    if (this.queue.length >= this.maximum) {
      this.overflowPending = true;
      if (message.kind === "event") return;
      const eventIndex = this.queue.findIndex((item) => item.kind === "event");
      if (eventIndex < 0) throw new Error("\u534F\u8BAE\u63A7\u5236\u961F\u5217\u8D85\u9650");
      this.queue.splice(eventIndex, 1);
      this.queue.unshift(message);
      return;
    }
    this.queue.push(message);
  }
  take() {
    if (this.overflowPending) {
      this.overflowPending = false;
      return {
        protocol: this.protocol,
        kind: "event",
        event: "needs_reconcile",
        code: "output_overflow"
      };
    }
    return this.queue.shift() ?? null;
  }
  get hasPending() {
    return this.overflowPending || this.queue.length > 0;
  }
};

// src/watcher.ts
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var FILESYNC_PROTOCOL_VERSION = 1;
var FILESYNC_MAX_PENDING_OUTPUT = 1e4;
var MAX_BUFFERED_PATHS = 2e4;
var IGNORED_NAMES = [".gugu-sync-"];
function relativePath(root, changedPath) {
  const value = (0, import_node_path.relative)(root, (0, import_node_path.resolve)(changedPath)).split(import_node_path.sep).join("/");
  if (!value || value === "." || value.startsWith("../") || value.includes("/../") || value === "..") return null;
  return value;
}
function isIgnored(path) {
  return path.split("/").some(
    (part) => IGNORED_NAMES.some((prefix) => part.startsWith(prefix)) || part.endsWith(".gugu-part") || part.endsWith(".gugu-tmp")
  );
}
function inScope(binding, path) {
  const first = path.split("/", 1)[0];
  return !binding.includedRootEntries || binding.includedRootEntries.has(first);
}
var FileSystemWatcher = class {
  bindings = /* @__PURE__ */ new Map();
  directories = /* @__PURE__ */ new Map();
  emit;
  createWatcher;
  constructor(emit, createWatcher = import_node_fs.watch) {
    this.emit = emit;
    this.createWatcher = createWatcher;
  }
  async watchBinding(bindingId, rootPath, includedRootEntries) {
    const root = (0, import_node_path.resolve)(rootPath);
    const included = includedRootEntries?.length ? new Set(includedRootEntries) : void 0;
    const current = this.bindings.get(bindingId);
    if (current?.root === root && this.sameScope(current.includedRootEntries, included)) {
      if (current.ready && !current.failed) this.emitReady(bindingId);
      return;
    }
    if (current) await this.unwatchBinding(bindingId);
    const binding = {
      root,
      entries: /* @__PURE__ */ new Map(),
      includedRootEntries: included,
      watchedDirectories: /* @__PURE__ */ new Set(),
      pending: /* @__PURE__ */ new Set(),
      timers: /* @__PURE__ */ new Map(),
      ready: false,
      initializing: true,
      failed: false,
      gapReported: false
    };
    this.bindings.set(bindingId, binding);
    void this.initialize(bindingId, binding);
  }
  sameScope(left, right) {
    if (!left || !right) return left === right;
    return left.size === right.size && [...left].every((value) => right.has(value));
  }
  isCurrent(bindingId, binding) {
    return this.bindings.get(bindingId) === binding;
  }
  emitReady(bindingId) {
    this.emit({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "ready", binding_id: bindingId });
  }
  reportPermissionGap(bindingId, binding) {
    this.reportGap(bindingId, binding, "watcher_permission_denied");
  }
  reportGap(bindingId, binding, code) {
    if (binding.gapReported || !this.isCurrent(bindingId, binding)) return;
    binding.gapReported = true;
    this.emit({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "needs_reconcile", binding_id: bindingId, code });
  }
  emitError(bindingId, binding, code) {
    if (!this.isCurrent(bindingId, binding) || binding.failed) return;
    binding.failed = true;
    this.emit({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "error", binding_id: bindingId, code });
  }
  watchDirectory(bindingId, binding, directory) {
    const absolute = (0, import_node_path.resolve)(directory);
    if (binding.watchedDirectories.has(absolute)) return;
    const shared = this.directories.get(absolute);
    if (shared) {
      shared.subscribers.add(bindingId);
      binding.watchedDirectories.add(absolute);
      return;
    }
    let watcher;
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
          const changed = (0, import_node_path.resolve)(absolute, String(filename));
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
      const errno = error;
      if (errno.code === "EACCES" || errno.code === "EPERM") {
        this.reportPermissionGap(bindingId, binding);
        return;
      }
      this.emitError(bindingId, binding, errno.code === "ENOSPC" ? "watcher_limit_exceeded" : "watcher_error");
      return;
    }
    const registration = { watcher, subscribers: /* @__PURE__ */ new Set([bindingId]) };
    this.directories.set(absolute, registration);
    binding.watchedDirectories.add(absolute);
    watcher.on("error", (error) => {
      if (this.directories.get(absolute) !== registration) return;
      this.directories.delete(absolute);
      for (const subscriberId of [...registration.subscribers]) {
        const subscriber = this.bindings.get(subscriberId);
        if (!subscriber) continue;
        subscriber.watchedDirectories.delete(absolute);
        if (error.code === "EACCES" || error.code === "EPERM") {
          this.reportPermissionGap(subscriberId, subscriber);
          continue;
        }
        this.emitError(subscriberId, subscriber, error.code === "ENOSPC" ? "watcher_limit_exceeded" : "watcher_error");
      }
    });
  }
  releaseDirectory(bindingId, binding, directory) {
    const absolute = (0, import_node_path.resolve)(directory);
    if (!binding.watchedDirectories.delete(absolute)) return;
    const shared = this.directories.get(absolute);
    if (!shared) return;
    shared.subscribers.delete(bindingId);
    if (shared.subscribers.size === 0) {
      this.directories.delete(absolute);
      shared.watcher.close();
    }
  }
  async initialize(bindingId, binding) {
    try {
      await this.scanDirectory(bindingId, binding, "");
      if (!this.isCurrent(bindingId, binding) || binding.failed) return;
      binding.initializing = false;
      const changedDuringScan = [...binding.pending];
      binding.pending.clear();
      for (const path of changedDuringScan) await this.processPath(bindingId, binding, path, "rename");
      if (!binding.failed && this.isCurrent(bindingId, binding)) {
        binding.ready = true;
        this.emitReady(bindingId);
      }
    } catch {
      if (this.isCurrent(bindingId, binding)) this.emitError(bindingId, binding, "watcher_scan_failed");
    }
  }
  async scanDirectory(bindingId, binding, prefix) {
    if (!this.isCurrent(bindingId, binding) || binding.failed) return;
    const directory = prefix ? (0, import_node_path.resolve)(binding.root, prefix) : binding.root;
    this.watchDirectory(bindingId, binding, directory);
    if (binding.failed) return;
    let children;
    try {
      children = await (0, import_promises.readdir)(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      const code = error?.code;
      if (prefix && (code === "EACCES" || code === "EPERM")) {
        this.reportPermissionGap(bindingId, binding);
        return;
      }
      throw error;
    }
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (isIgnored(path) || prefix === "" && binding.includedRootEntries && !binding.includedRootEntries.has(path) || child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        binding.entries.set(path, { objectType: "folder" });
        await this.scanDirectory(bindingId, binding, path);
      } else if (child.isFile()) {
        binding.entries.set(path, { objectType: "file" });
      }
    }
  }
  schedulePath(bindingId, binding, path, eventType) {
    const existing = binding.timers.get(path);
    if (existing) clearTimeout(existing);
    const delay = eventType === "change" ? 300 : 80;
    binding.timers.set(path, setTimeout(() => {
      binding.timers.delete(path);
      void this.processPath(bindingId, binding, path, eventType);
    }, delay));
  }
  async processPath(bindingId, binding, path, _eventType) {
    if (!this.isCurrent(bindingId, binding) || binding.failed) return;
    const absolute = (0, import_node_path.resolve)(binding.root, path);
    try {
      const stats = await (0, import_promises.lstat)(absolute);
      if (stats.isSymbolicLink()) {
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
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      const stable = await (0, import_promises.lstat)(absolute);
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
      if (error?.code !== "ENOENT") {
        this.reportGap(bindingId, binding, "watcher_path_unavailable");
        return;
      }
      const removed = [...binding.entries.keys()].filter((entry) => entry === path || entry.startsWith(`${path}/`));
      if (!removed.length) return;
      for (const entry of removed) {
        const previous = binding.entries.get(entry);
        binding.entries.delete(entry);
        this.emitChange(bindingId, "delete", previous.objectType, entry);
      }
      for (const directory of [...binding.watchedDirectories]) {
        if (directory === absolute || directory.startsWith(`${absolute}${import_node_path.sep}`)) this.releaseDirectory(bindingId, binding, directory);
      }
    }
  }
  emitChange(bindingId, operation, objectType, path) {
    this.emit({
      protocol: FILESYNC_PROTOCOL_VERSION,
      kind: "event",
      event: "change",
      binding_id: bindingId,
      operation,
      object_type: objectType,
      relative_path: path
    });
  }
  async unwatchBinding(bindingId) {
    const binding = this.bindings.get(bindingId);
    if (!binding) return;
    this.bindings.delete(bindingId);
    for (const timer of binding.timers.values()) clearTimeout(timer);
    binding.timers.clear();
    for (const directory of [...binding.watchedDirectories]) this.releaseDirectory(bindingId, binding, directory);
  }
  async close() {
    await Promise.all([...this.bindings.keys()].map((bindingId) => this.unwatchBinding(bindingId)));
  }
};

// src/index.ts
var output = new BoundedProtocolOutput(FILESYNC_MAX_PENDING_OUTPUT, FILESYNC_PROTOCOL_VERSION);
var writing = false;
function writeMessage(message) {
  output.enqueue(message);
  flushOutput();
}
function flushOutput() {
  if (writing) return;
  writing = true;
  while (output.hasPending) {
    const message = output.take();
    if (!process.stdout.write(JSON.stringify(message) + "\n")) {
      process.stdout.once("drain", () => {
        writing = false;
        flushOutput();
      });
      return;
    }
  }
  writing = false;
}
function response(request, status, code) {
  writeMessage({
    protocol: FILESYNC_PROTOCOL_VERSION,
    kind: "response",
    id: request.id,
    status,
    ...code ? { code } : {}
  });
}
async function run() {
  const watcher = new FileSystemWatcher(writeMessage);
  const input = (0, import_node_readline.createInterface)({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      writeMessage({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "response", status: "error", code: "invalid_json" });
      continue;
    }
    if (request.protocol !== FILESYNC_PROTOCOL_VERSION) {
      response(request, "error", "protocol_mismatch");
      continue;
    }
    try {
      if (request.op === "ping") {
        response(request, "ok");
      } else if (request.op === "watch" && Number.isInteger(request.binding_id) && request.root) {
        await watcher.watchBinding(request.binding_id, request.root, request.included_root_entries);
        response(request, "ok");
      } else if (request.op === "unwatch" && Number.isInteger(request.binding_id)) {
        await watcher.unwatchBinding(request.binding_id);
        response(request, "ok");
      } else if (request.op === "refresh") {
        writeMessage({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "needs_reconcile", code: "requested" });
        response(request, "ok");
      } else if (request.op === "shutdown") {
        response(request, "ok");
        await watcher.close();
        input.close();
        process.stdin.destroy();
        break;
      } else {
        response(request, "error", "invalid_request");
      }
    } catch {
      response(request, "error", "watcher_failure");
    }
  }
  await watcher.close();
}
run().catch(() => {
  writeMessage({ protocol: FILESYNC_PROTOCOL_VERSION, kind: "event", event: "error", code: "worker_failure" });
  process.exitCode = 1;
});
