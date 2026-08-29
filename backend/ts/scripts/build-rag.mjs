import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const backendDir = resolve(import.meta.dirname, "../..");
const result = spawnSync("make", ["-C", backendDir, "rag-ts-build"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
