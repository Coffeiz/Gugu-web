import { once } from "node:events";
import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import test from "node:test";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const workerDir = resolve(import.meta.dirname, "..");

test("RAG worker 遵守 JSONL ping 与 replace/search contract", async (t) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd: workerDir });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const pending: Array<(value: string) => void> = [];
  const received: string[] = [];
  lines.on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter(line);
    else received.push(line);
  });
  const readResponse = async (): Promise<Record<string, unknown>> => {
    const line = received.shift() ?? await new Promise<string>((resolveLine) => pending.push(resolveLine));
    return JSON.parse(line) as Record<string, unknown>;
  };
  child.stdin.write('{"op":"ping"}\n');
  assert.equal((await readResponse()).status, "ok");
  child.stdin.write(JSON.stringify({ op: "replace", revision: "r1", documents: [{ id: "d1", text: "画布里的麦子", source_type: "canvas", scope_type: "owner", scope_id: "o1", document_version: "1" }] }) + "\n");
  assert.equal((await readResponse()).revision, "r1");
  child.stdin.write('{"op":"search","revision":"r1","query":"麦子","limit":5}\n');
  const result = await readResponse();
  assert.equal(result.status, "ok");
  assert.equal((result.results as Array<Record<string, unknown>>)[0].id, "d1");
  child.stdin.end();
  await once(child, "close");
});
