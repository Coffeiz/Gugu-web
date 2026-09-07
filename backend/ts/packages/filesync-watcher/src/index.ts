import { createInterface } from "node:readline";
import {
  FILESYNC_MAX_PENDING_OUTPUT,
  FILESYNC_PROTOCOL_VERSION,
  FileSystemWatcher,
  type WatchEvent,
} from "./watcher.ts";

type Request = {
  protocol?: number;
  id?: string;
  op?: "ping" | "watch" | "unwatch" | "refresh" | "shutdown";
  binding_id?: number;
  root?: string;
};

type Response = {
  protocol: number;
  kind: "response";
  id?: string;
  status: "ok" | "error";
  code?: string;
};

const output: string[] = [];
let writing = false;
let overflowReported = false;

function writeMessage(message: Response | WatchEvent): void {
  if (output.length >= FILESYNC_MAX_PENDING_OUTPUT) {
    output.length = 0;
    if (!overflowReported) {
      output.push(JSON.stringify({
        protocol: FILESYNC_PROTOCOL_VERSION,
        kind: "event",
        event: "needs_reconcile",
        code: "output_overflow",
      } satisfies WatchEvent) + "\n");
      overflowReported = true;
    }
  }
  output.push(JSON.stringify(message) + "\n");
  flushOutput();
}

function flushOutput(): void {
  if (writing) return;
  writing = true;
  while (output.length) {
    if (!process.stdout.write(output.shift()!)) {
      process.stdout.once("drain", () => {
        writing = false;
        flushOutput();
      });
      return;
    }
  }
  overflowReported = false;
  writing = false;
}

function response(request: Request, status: Response["status"], code?: string): void {
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
        await watcher.watchBinding(request.binding_id!, request.root);
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
