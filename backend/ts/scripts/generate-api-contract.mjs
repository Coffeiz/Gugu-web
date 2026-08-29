import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const scriptDir = resolve(import.meta.dirname);
const repoDir = resolve(scriptDir, "../../..");
const input = process.argv[2] ?? process.env.OPENAPI_SOURCE ?? "http://127.0.0.1:8000/openapi.json";
const binary = resolve(repoDir, "frontend/node_modules/.bin/openapi-typescript");
const output = resolve(scriptDir, "../packages/contracts/src/api.d.ts");

await mkdir(resolve(output, ".."), { recursive: true });
const child = spawn(binary, [input, "-o", output], { stdio: "inherit" });
child.on("error", (error) => { throw error; });
child.on("exit", (code) => process.exit(code ?? 1));
