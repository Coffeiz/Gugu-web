import { build } from 'esbuild'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(desktop, '../..')
const core = resolve(root, 'packages/core')
const outfile = resolve(desktop, '.tools/agent/runtime.mjs')

export async function buildDesktopAgentRuntime() {
  mkdirSync(dirname(outfile), { recursive: true })
  await build({
    entryPoints: [resolve(desktop, 'src/main/agent/runtime.ts')],
    tsconfig: resolve(desktop, 'tsconfig.json'),
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    target: 'node26',
    format: 'esm',
  })
  const source = readFileSync(outfile, 'utf8')
  const require = createRequire(resolve(core, 'package.json'))
  const desktopRequire = createRequire(resolve(desktop, 'package.json'))
  const modules = new Map([...source.matchAll(/(?:from\s*|import\s*)['"]([^.'"/][^'"]*)['"]/gu)]
    .map(match => match[1])
    .filter(name => !name.startsWith('node:'))
    .map(specifier => [specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0], specifier]))
  const nodeModules = resolve(desktop, '.tools/agent/node_modules')
  mkdirSync(nodeModules, { recursive: true })
  for (const [name, specifier] of modules) {
    const resolved = (name === '@gugu/gateway' ? desktopRequire : require).resolve(specifier)
    let directory = dirname(resolved)
    while (directory !== dirname(directory)) {
      const packagePath = resolve(directory, 'package.json')
      if (existsSync(packagePath) && JSON.parse(readFileSync(packagePath, 'utf8')).name === name) break
      directory = dirname(directory)
    }
    if (directory === dirname(directory)) throw new Error(`桌面 Agent 依赖无法解析：${name}`)
    const target = resolve(nodeModules, name)
    mkdirSync(dirname(target), { recursive: true })
    if (lstatSync(target, { throwIfNoEntry: false })) rmSync(target, { recursive: true, force: true })
    symlinkSync(directory, target, 'junction')
  }
  cpSync(resolve(core, 'src/agent/subagent/searcher/prompt.md'), resolve(dirname(outfile), 'prompt.md'))
  cpSync(resolve(core, 'resources/prompts'), resolve(desktop, '.tools/agent-prompts'), { recursive: true })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  await buildDesktopAgentRuntime()
