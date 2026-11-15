import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const filename = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

async function readText(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error()
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!(await handle.stat()).isFile()) throw new Error()
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await handle.readFile())
  } finally { await handle.close() }
}

function parseManifest(text) {
  const value = JSON.parse(text)
  if (!record(value) || value.version !== 1 || !Array.isArray(value.documents) || !value.documents.length
    || (value.excluded !== undefined && !Array.isArray(value.excluded))) throw new Error()
  const names = new Set(), ids = new Set()
  for (const entry of [...value.documents, ...(value.excluded ?? [])]) {
    if (!record(entry) || typeof entry.id !== 'string' || !/^S[0-9]+$/u.test(entry.id)
      || typeof entry.file !== 'string' || !filename.test(entry.file)
      || names.has(entry.file) || ids.has(entry.id)) throw new Error()
    names.add(entry.file); ids.add(entry.id)
  }
  for (const entry of value.excluded ?? []) if (typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error()
  return value
}

function moduleSource(documents) {
  return `// 由构建脚本按显式白名单嵌入；只提供文档，不自动注册或授予工具权限。\nconst embedded = Object.freeze(${JSON.stringify(documents)}.map(item => Object.freeze(item)))\n\nexport function createBundledSkillDocuments() {\n  return Object.freeze(embedded.map(({ name, content }) => Object.freeze({\n    name,\n    async read(signal) { signal.throwIfAborted(); return content },\n  })))\n}\n`
}

/** 先验证全部资源再写制品；默认仅使用Core自有资源，导入模块不会触发构建。 */
export async function buildAgentSkills(options = {}) {
  let staging
  try {
    const { sourceDirectory, outputDirectory } = options
    const source = resolve(sourceDirectory ?? join(coreRoot, 'resources/agent-skills'))
    const output = resolve(outputDirectory ?? join(coreRoot, 'dist/agent/skills'))
    const sourceInfo = await lstat(source)
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new Error()
    const manifest = parseManifest(await readText(join(source, 'manifest.json')))
    const documents = []
    for (const entry of manifest.documents) documents.push({ name: entry.file, content: await readText(join(source, entry.file)) })
    // 动态导入必须发生在函数调用时，正常Core编译完成后；不依赖Python源码目录。
    const { createBuiltinSkillDefinitions } = await import(pathToFileURL(join(coreRoot, 'dist/agent/skills/builtin.js')).href)
    const definitions = await createBuiltinSkillDefinitions(documents.map(item => ({ name: item.name, async read(signal) { signal.throwIfAborted(); return item.content } })), new AbortController().signal)
    if (definitions.length !== documents.length) throw new Error()
    const displayNames = new Set()
    for (let index = 0; index < definitions.length; index++) {
      const definition = definitions[index]
      if (definition.id !== manifest.documents[index].id || definition.source !== 'builtin'
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
    staging = await mkdtemp(join(output, '.agent-skills-'))
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
