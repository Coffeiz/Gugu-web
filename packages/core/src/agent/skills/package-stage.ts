import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CoreError } from '../../contracts/index.js'
import { parseSkillDocument, SKILL_ENTRY_FILE, skillBundleDirectory, type SkillStorageSource } from './bundle.js'
import { ensureSkillDirectory } from './safe-directory.js'

const maxBytes = 30 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })
type FileSet = ReadonlyMap<string, Uint8Array>

function validate(files: FileSet) {
  if (!files.size || files.size > 500) throw new CoreError('invalid_request', '技能包文件数量无效')
  const names = new Set<string>()
  let size = 0
  for (const [path, content] of files) {
    const parts = path.split('/')
    const folded = path.toLowerCase()
    if (!path || path.length > 1024 || path.includes('\\') || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))
      || parts[0]?.includes(':') || names.has(folded) || !(content instanceof Uint8Array))
      throw new CoreError('invalid_request', '技能包路径无效')
    size += content.byteLength
    if (size > maxBytes) throw new CoreError('invalid_request', '技能包超过大小限制')
    names.add(folded)
  }
  for (const name of names) {
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++)
      if (names.has(parts.slice(0, i).join('/'))) throw new CoreError('invalid_request', '技能包路径冲突')
  }
  const entry = files.get(SKILL_ENTRY_FILE)
  if (!entry) throw new CoreError('invalid_request', '技能包缺少入口文档')
  try { parseSkillDocument(decoder.decode(entry)) }
  catch { throw new CoreError('invalid_request', '技能入口文档无效') }
}

/** 验证并暂存技能包；只有宿主的文件事务能将暂存目录发布到目标并登记撤销。 */
export async function stageSkillPackage<T>(options: {
  dataRoot: string
  ownerId: string
  storageSource?: SkillStorageSource
  slug: string
  files: FileSet
  signal: AbortSignal
  commit(input: { ownerId: string; slug: string; stagedDirectory: string; targetDirectory: string; signal: AbortSignal }): Promise<T>
}): Promise<T> {
  const { dataRoot, ownerId, slug, signal } = options
  const storageSource = options.storageSource ?? 'user'
  signal.throwIfAborted()
  const targetDirectory = skillBundleDirectory(dataRoot, ownerId, storageSource, slug)
  const otherSource = storageSource === 'user' ? 'clawhub' : 'user'
  try {
    await lstat(skillBundleDirectory(dataRoot, ownerId, otherSource, slug))
    throw new CoreError('conflict', '技能目录名已被另一来源使用')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  validate(options.files)
  await ensureSkillDirectory(dataRoot, dirname(targetDirectory))
  const files = new Map([...options.files].map(([path, content]) => [path, Uint8Array.from(content)]))
  const agentRoot = join(dataRoot, ownerId, '.agent')
  const stagingRoot = join(agentRoot, '.skill-staging')
  const realStage = await ensureSkillDirectory(dataRoot, stagingRoot)
  const stagedDirectory = await mkdtemp(join(realStage, 'package-'))
  try {
    for (const [path, content] of files) {
      signal.throwIfAborted()
      const destination = join(stagedDirectory, ...path.split('/'))
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { await file.writeFile(content); await file.sync() }
      finally { await file.close() }
    }
    signal.throwIfAborted()
    return await options.commit({ ownerId, slug, stagedDirectory, targetDirectory, signal })
  } finally {
    await rm(stagedDirectory, { recursive: true, force: true })
  }
}
