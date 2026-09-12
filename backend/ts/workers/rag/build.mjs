import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const workerDirectory = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(workerDirectory, "src/index.ts")],
  outfile: resolve(workerDirectory, "../../../bin/gugu-rag-ts-worker.mjs"),
  platform: "node",
  format: "esm",
  bundle: true,
  minifyWhitespace: true,
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  external: ["@node-rs/jieba", "@node-rs/jieba/*", "proxy-agent"],
});
