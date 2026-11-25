import { copyFileSync, lstatSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import lockfile from 'proper-lockfile'
import { buildAgentSkills } from './build-skills.mjs'
import { coreRoot } from './test-suites.mjs'

const require = createRequire(import.meta.url)
const run = promisify(execFile)

async function compile(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, args)
    process.stdout.write(stdout)
    process.stderr.write(stderr)
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout)
    if (error.stderr) process.stderr.write(error.stderr)
    throw error
  }
}

function publishDirectory(staged, output) {
  if (existsSync(output) && !lstatSync(output).isDirectory())
    throw new Error('Core 构建产物路径不是普通目录')
  mkdirSync(output, { recursive: true })
  // 清理本次产物里已不存在的陈旧条目：源码删除后旧产物会永久残留，
  // 既撑大安装包，也会把已下线的代码重新带进制品。
  const stagedNames = new Set(readdirSync(staged))
  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (!stagedNames.has(entry.name)) rmSync(join(output, entry.name), { recursive: true, force: true })
  }
  for (const entry of readdirSync(staged, { withFileTypes: true })) {
    const destination = join(output, entry.name)
    const source = join(staged, entry.name)
    if (entry.isDirectory()) publishDirectory(source, destination)
    else renameSync(source, destination)
  }
}

export async function buildCore(consume) {
  const lockDirectory = join(coreRoot, 'node_modules/.cache')
  mkdirSync(lockDirectory, { recursive: true })
  // 构建者与打包者串行，运行中的开发服务可以持续读取现有产物。
  const release = await lockfile.lock(coreRoot, {
    lockfilePath: join(lockDirectory, 'core-build.lock'),
    stale: 60_000,
    retries: { retries: 120, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
  })
  try {
    const tsc = require.resolve('typescript/bin/tsc')
    for (const name of ['sandbox', 'database', 'search'])
      await compile([tsc, '-p', resolve(coreRoot, `../${name}/tsconfig.json`)])

    const output = resolve(coreRoot, 'dist')
    if (relative(coreRoot, output) !== 'dist' ||
      (existsSync(output) && lstatSync(output).isSymbolicLink()))
      throw new Error('Core 构建产物路径超出预期范围')

    const staged = mkdtempSync(join(coreRoot, '.dist-build-'))
    try {
      await compile([tsc, '-p', join(coreRoot, 'tsconfig.json'), '--outDir', staged])
      copyFileSync(join(coreRoot, 'src/agent/subagent/searcher/prompt.md'), join(staged, 'agent/subagent/searcher/prompt.md'))
      const skills = join(staged, 'agent/skills')
      await buildAgentSkills({ outputDirectory: skills, builtinModule: join(skills, 'builtin.js') })
      publishDirectory(staged, output)
    } finally {
      rmSync(staged, { recursive: true, force: true })
    }
    return await consume?.()
  } finally {
    await release()
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await buildCore()
