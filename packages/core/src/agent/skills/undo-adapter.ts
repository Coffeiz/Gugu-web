import { UndoAdapterConflict, UndoAdapterUnsupported, type UndoMode, type UndoResourceAdapter } from '../../undo/state-machine.js'
import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import type { SkillStorageSource } from './bundle.js'

/** 文件移动由宿主完成，数据库回滚时由调用方执行返回的补偿操作。 */
export interface SkillPackageUndoStorage {
  move(input: { ownerId: string; slug: string; storageSource?: SkillStorageSource; operationId: string; digest: string; mode: UndoMode }): Promise<() => Promise<void>>
  replace?(input: { ownerId: string; slug: string; storageSource?: SkillStorageSource; expectedDigest: string; content: string }): Promise<{ rollback(): Promise<void>; finalize(): Promise<void> }>
}

export function createSkillPackageUndoAdapter(storage: SkillPackageUndoStorage, rollbacks: Array<() => Promise<void>>,
  finalizers: Array<() => Promise<void>> = [], backend: 'postgres' | 'sqlite' = 'sqlite'): UndoResourceAdapter {
  return {
    async apply({ tx, owner, row, mode }) {
      if (row.action !== 'install' && row.action !== 'update' && row.action !== 'remove') throw new UndoAdapterUnsupported('undo.unsupported', '该技能操作尚不支持撤销')
      let value: unknown
      try { value = typeof row.after_state === 'string' ? JSON.parse(row.after_state) : row.after_state }
      catch { throw new UndoAdapterUnsupported('undo.unsupported', '技能撤销记录无效') }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new UndoAdapterUnsupported('undo.unsupported', '技能撤销记录无效')
      const { slug, digest, source, storage_source: storageSource } = value as Record<string, unknown>
      if (typeof slug !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(slug)
        || (storageSource !== 'user' && storageSource !== 'clawhub')
        || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)
        || !/^op-[a-f0-9]{32}$/u.test(row.id))
        throw new UndoAdapterUnsupported('undo.unsupported', '技能撤销记录无效')
      if (backend === 'postgres') await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill:${owner}:${slug}`}, 0))`.execute(tx)
      try {
        if (row.action === 'install' || row.action === 'remove') rollbacks.push(await storage.move({ ownerId: owner, slug, storageSource, operationId: row.id, digest,
          mode: row.action === 'remove' ? (mode === 'undo' ? 'redo' : 'undo') : mode }))
        else {
          let before: unknown
          try { before = typeof row.before_state === 'string' ? JSON.parse(row.before_state) : row.before_state }
          catch { throw new UndoAdapterUnsupported('undo.unsupported', '技能撤销记录无效') }
          const previous = before && typeof before === 'object' && !Array.isArray(before) ? before as Record<string, unknown> : {}
          if (!storage.replace || typeof source !== 'string' || typeof previous.source !== 'string'
            || typeof previous.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(previous.digest)
            || Buffer.byteLength(source) > 256 * 1024 || Buffer.byteLength(previous.source) > 256 * 1024
            || createHash('sha256').update(source).digest('hex') !== digest
            || createHash('sha256').update(previous.source).digest('hex') !== previous.digest)
            throw new UndoAdapterUnsupported('undo.unsupported', '技能撤销记录无效')
          const result = await storage.replace({ ownerId: owner, slug, storageSource,
            expectedDigest: mode === 'undo' ? digest : previous.digest,
            content: mode === 'undo' ? previous.source : source })
          rollbacks.push(result.rollback); finalizers.push(result.finalize)
        }
      }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'conflict')
          throw new UndoAdapterConflict('undo.conflict', '技能文件已变化，无法撤销或重做')
        throw error
      }
      return { versions: {}, events: [{ resource: 'skills', operation: 'refresh', entity_ids: [slug], origin: `undo:${row.id}` }] }
    },
  }
}
