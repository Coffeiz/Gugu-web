import { build } from 'esbuild'

export const bundledChartPackages = [
  'mermaid', '@mermaid-js/mermaid-zenuml', '@zenuml/core', 'es-toolkit', 'highlight.js',
]

export function bundleChartWorker(source, outfile) {
  return build({
    entryPoints: [source],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    metafile: true,
    external: ['mathjax', 'svgdom', 'fontkit', '@resvg/resvg-js'],
    banner: { js: "import { createRequire as bundleCreateRequire } from 'node:module'; const require = bundleCreateRequire(import.meta.url);" },
  })
}
