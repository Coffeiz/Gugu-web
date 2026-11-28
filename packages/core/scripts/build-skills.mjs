import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const filename = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u

async function readText(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error()
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!(await handle.stat()).isFile()) throw new Error()
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await handle.readFile())
  } finally { await handle.close() }
}

export async function discoverSkillDocuments(sourceDirectory) {
  const source = resolve(sourceDirectory)
  const sourceInfo = await lstat(source)
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new Error()
  const entries = await readdir(source, { withFileTypes: true })
  const names = entries
    .filter(entry => filename.test(entry.name) && entry.name.toUpperCase() !== 'README.MD')
    .map(entry => entry.name)
    .sort()
  const documents = []
  for (const name of names) {
    const entry = entries.find(item => item.name === name)
    if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error()
    documents.push({ name, content: await readText(join(source, name)) })
  }
  if (documents.length === 0) throw new Error()
  return documents
}

function moduleSource(documents) {
  return `// 由构建脚本自动嵌入资源目录中的 Markdown；运行时按文件名分配编号，解析头部元数据。\nconst embedded = Object.freeze(${JSON.stringify(documents)}.map(item => Object.freeze(item)))\n\nexport function createBundledSkillDocuments() {\n  return Object.freeze(embedded.map(({ name, content }) => Object.freeze({\n    name,\n    async read(signal) { signal.throwIfAborted(); return content },\n  })))\n}\n`
}

/** 先验证全部资源再写制品；默认仅使用Core自有资源，导入模块不会触发构建。 */
export async function buildAgentSkills(options = {}) {
  let staging
  try {
    const { sourceDirectory, outputDirectory, builtinModule } = options
    const source = resolve(sourceDirectory ?? join(coreRoot, 'resources/skills'))
    const output = resolve(outputDirectory ?? join(coreRoot, 'dist/agent/skills'))
    const documents = await discoverSkillDocuments(source)
    // 动态导入必须发生在函数调用时，正常Core编译完成后；不依赖Python源码目录。
    const { createBuiltinSkillDefinitions } = await import(pathToFileURL(builtinModule ?? join(coreRoot, 'dist/agent/skills/builtin.js')).href)
    const definitions = await createBuiltinSkillDefinitions(documents.map(item => ({ name: item.name, async read(signal) { signal.throwIfAborted(); return item.content } })), new AbortController().signal)
    if (definitions.length !== documents.length) throw new Error()
    const displayNames = new Set()
    for (let index = 0; index < definitions.length; index++) {
      const definition = definitions[index]
      if (definition.source !== 'builtin'
        || !definition.name.trim() || displayNames.has(definition.name)) throw new Error()
      displayNames.add(definition.name)
    }
    const javascript = moduleSource(documents)
    const declaration = "import type { BuiltinSkillDocument } from './builtin.js'\n\nexport declare function createBundledSkillDocuments(): readonly BuiltinSkillDocument[]\n"
    await mkdir(output, { recursive: true })
    const outputInfo = await lstat(output)
    if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) throw new Error()
    for (const name of ['bundled.js', 'bundled.d.ts']) {
      try { if ((await lstat(join(output, name))).isSymbolicLink()) throw new Error() }
      catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
    staging = await mkdtemp(join(output, '.skills-'))
    await writeFile(join(staging, 'bundled.js'), javascript, 'utf8')
    await writeFile(join(staging, 'bundled.d.ts'), declaration, 'utf8')
    await rename(join(staging, 'bundled.js'), join(output, 'bundled.js'))
    await rename(join(staging, 'bundled.d.ts'), join(output, 'bundled.d.ts'))
  } catch {
    throw new Error('内置技能制品构建失败')
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await buildAgentSkills()
