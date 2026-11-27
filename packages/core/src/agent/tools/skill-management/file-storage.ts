import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Transaction } from 'kysely'
import { CoreError, dataContext } from '../../../contracts/index.js'
import type { Database } from '../../../data/schema.js'
import { ensureSkillDirectory } from '../../skills/safe-directory.js'
import { readUserSkillBundle } from '../../skills/bundle-store.js'
import { userSkillDirectory } from '../../skills/bundle.js'
import { skillPackageDigest } from '../../skills/package-digest.js'
import { stageSkillPackage } from '../../skills/package-stage.js'
import { stableJson } from '../../context/history/canonical-history.js'
import { createAgentSkillDocument, updateAgentSkillDocument } from './file-document.js'
import type { FileSkillCreateInput, FileSkillUpdateInput } from './file-tools.js'
import type { FileSkillMutationAdapter } from './file-port.js'

type Journal = { version: 1; fingerprint: string; action: 'create' | 'update'; slug: string;
  before: string | null; after: string; packageDigest: string | null }
type History = { ownerId: string; sessionId: string; runId: string; operationId: string; slug: string;
  action: 'install' | 'update'; before: string | null; after: string; packageDigest: string | null }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const conflict = () => new CoreError('conflict', '技能文件已变化，无法恢复操作')
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** 本地技能写入日志；日志在文件变更前持久化，恢复时仅处理与日志匹配的版本。 */
export function createLocalAgentSkillMutationAdapter(options: {
  dataRoot: string
  lock(tx: Transaction<Database>, ownerId: string, slug: string, operationId: string, signal: AbortSignal): Promise<void>
  release?(ownerId: string, operationId: string): Promise<void>
  knownTools(ownerId: string, related: readonly string[]): Promise<ReadonlySet<string>>
  record(tx: Transaction<Database>, history: History): Promise<void>
  publish(ownerId: string, operationId: string): Promise<void>
}): FileSkillMutationAdapter {
  const coordinates = (input: Parameters<FileSkillMutationAdapter['recover']>[0]) => {
    const owner = dataContext(input.identity.ownerId).ownerId
    if (!/^[a-f0-9-]{36}$/u.test(input.operationId)) throw new CoreError('invalid_request', '技能操作标识无效')
    const slug = input.action === 'create' ? `skill-${input.operationId}` : (input.fields as FileSkillUpdateInput).id
    const directory = userSkillDirectory(options.dataRoot, owner, slug)
    const journalDirectory = join(dirname(dirname(dirname(directory))), '.skill-journal')
    const journal = join(journalDirectory, `${input.operationId}.json`)
    const fingerprint = digest(stableJson([input.action, input.fields, owner]))
    return { owner, slug, directory, journalDirectory, journal, fingerprint }
  }
  async function loadJournal(path: string): Promise<Journal | null> {
    let handle
    try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
    catch (error) { if (missing(error)) return null; throw error }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 600_000) throw conflict()
      const raw: unknown = JSON.parse(await handle.readFile('utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw conflict()
      const value = raw as Partial<Journal>
      if (value.version !== 1 || !/^[a-f0-9]{64}$/u.test(value.fingerprint ?? '')
        || !['create', 'update'].includes(value.action ?? '') || typeof value.slug !== 'string'
        || (value.before !== null && typeof value.before !== 'string') || typeof value.after !== 'string'
        || (value.packageDigest !== null && !/^[a-f0-9]{64}$/u.test(value.packageDigest ?? ''))) throw conflict()
      return value as Journal
    } finally { await handle.close() }
  }
  async function writeJournal(path: string, value: Journal) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  }
  async function replace(owner: string, slug: string, expected: string, content: string) {
    const current = await readUserSkillBundle(options.dataRoot, owner, slug)
    if (current.contentDigest !== expected) throw conflict()
    const entry = join(current.path, 'SKILL.md'), staged = join(current.path, `.skill-write-${randomUUID()}`)
    try {
      const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      if ((await readUserSkillBundle(options.dataRoot, owner, slug)).contentDigest !== expected) throw conflict()
      await rename(staged, entry)
    } finally { await rm(staged, { force: true }) }
  }
  async function recover(input: Parameters<FileSkillMutationAdapter['recover']>[0], alreadyLocked = false) {
    const loc = coordinates(input)
    if (!alreadyLocked) await options.lock(input.tx, loc.owner, loc.slug, input.operationId, input.signal)
    await ensureSkillDirectory(options.dataRoot, loc.journalDirectory)
    const journal = await loadJournal(loc.journal)
    if (!journal) return
    if (journal.fingerprint !== loc.fingerprint || journal.action !== input.action || journal.slug !== loc.slug) throw conflict()
    if (journal.action === 'create') {
      let exists = false
      try { const stat = await lstat(loc.directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict(); exists = true }
      catch (error) { if (!missing(error)) throw error }
      if (exists) {
        await readUserSkillBundle(options.dataRoot, loc.owner, loc.slug)
        if (!journal.packageDigest || await skillPackageDigest(loc.directory) !== journal.packageDigest) throw conflict()
        await rm(loc.directory, { recursive: true })
      }
    } else {
      if (journal.before === null) throw conflict()
      const current = await readUserSkillBundle(options.dataRoot, loc.owner, loc.slug)
      if (current.contentDigest === digest(journal.after)) await replace(loc.owner, loc.slug, current.contentDigest, journal.before)
      else if (current.contentDigest !== digest(journal.before)) throw conflict()
    }
    await rm(loc.journal)
  }
  return {
    recover,
    async prepare(input) {
      const loc = coordinates({ ...input, tx: undefined as never })
      const known = new Set([...await options.knownTools(loc.owner, input.fields.related_tools ?? []), ...input.relatedTools])
      const previous = input.action === 'update' ? await readUserSkillBundle(options.dataRoot, loc.owner, loc.slug) : null
      const after = input.action === 'create' ? createAgentSkillDocument(input.fields as FileSkillCreateInput, known)
        : updateAgentSkillDocument(previous!.source, input.fields as FileSkillUpdateInput, known)
      let written = false
      return {
        async apply(tx, signal) {
          if (input.action === 'create') {
            await stageSkillPackage({ dataRoot: options.dataRoot, ownerId: loc.owner, slug: loc.slug,
              files: new Map([['SKILL.md', Buffer.from(after)]]), signal,
              async commit({ stagedDirectory, targetDirectory }) {
                const packageDigest = await skillPackageDigest(stagedDirectory)
                await ensureSkillDirectory(options.dataRoot, dirname(targetDirectory))
                await writeJournal(loc.journal, { version: 1, fingerprint: loc.fingerprint, action: 'create', slug: loc.slug,
                  before: null, after, packageDigest })
                try { await mkdir(targetDirectory, { mode: 0o700 }) }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict(); throw error }
                try { await rename(stagedDirectory, targetDirectory); written = true }
                catch (error) { await rmdir(targetDirectory).catch(() => {}); throw error }
                await options.record(tx, { ...input.identity, ownerId: loc.owner, operationId: input.operationId,
                  slug: loc.slug, action: 'install', before: null, after, packageDigest })
              } })
          } else {
            await writeJournal(loc.journal, { version: 1, fingerprint: loc.fingerprint, action: 'update', slug: loc.slug,
              before: previous!.source, after, packageDigest: null })
            await replace(loc.owner, loc.slug, previous!.contentDigest, after)
            written = true
            await options.record(tx, { ...input.identity, ownerId: loc.owner, operationId: input.operationId,
              slug: loc.slug, action: 'update', before: previous!.source, after, packageDigest: null })
          }
          return { success: true, skill: { id: loc.slug }, message: input.action === 'create' ? '已创建技能。' : '已更新技能。' }
        },
        async rollback(tx) {
          if (!written) { await rm(loc.journal, { force: true }); return }
          await recover({ ...input, tx }, true)
        },
        async finalize() { await rm(loc.journal, { force: true }) },
      }
    },
    published: options.publish,
    release: options.release,
  }
}
