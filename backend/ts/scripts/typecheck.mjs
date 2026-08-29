import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoDir = resolve(import.meta.dirname, "../../..");
const tsc = resolve(repoDir, "frontend/node_modules/typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-p", resolve(import.meta.dirname, "../tsconfig.json")], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
