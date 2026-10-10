import { createInterface } from "node:readline";
import { BoundedProtocolOutput, type ProtocolMessage } from "./protocol-output.ts";
import {
  FILESYNC_MAX_PENDING_OUTPUT,
  FILESYNC_PROTOCOL_VERSION,
  FileSystemWatcher,
} from "./watcher.ts";

type Request = {
  protocol?: number;
  id?: string;
  op?: "ping" | "watch" | "unwatch" | "refresh" | "shutdown";
  binding_id?: number;
  root?: string;
  included_root_entries?: string[];
};

const output = new BoundedProtocolOutput(FILESYNC_MAX_PENDING_OUTPUT, FILESYNC_PROTOCOL_VERSION);
let writing = false;

function writeMessage(message: ProtocolMessage): void {
  output.enqueue(message);
  flushOutput();
}

function flushOutput(): void {
  if (writing) return;
  writing = true;
  while (output.hasPending) {
    const message = output.take()!;
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

function response(request: Request, status: "ok" | "error", code?: string): void {
  writeMessage({
    protocol: FILESYNC_PROTOCOL_VERSION,
    kind: "response",
    id: request.id,
    status,
    ...(code ? { code } : {}),
  });
}

async function run(): Promise<void> {
  const watcher = new FileSystemWatcher(writeMessage);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
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
        await watcher.watchBinding(request.binding_id!, request.root, request.included_root_entries);
        response(request, "ok");
      } else if (request.op === "unwatch" && Number.isInteger(request.binding_id)) {
        await watcher.unwatchBinding(request.binding_id!);
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
