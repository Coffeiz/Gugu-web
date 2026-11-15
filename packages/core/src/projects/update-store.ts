import { sql, type Transaction } from 'kysely'
import type { Database } from '../data/schema.js'
import { nowUtc, type Clock } from '../data/codec.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import type { ProjectUpdateTransaction } from './project-update.js'
import { SqlProjectRepository } from './repository.js'

/** 复用项目仓储与Undo生命周期；所有字段、文件前缀和收据由外层同一事务提交。 */
export function createKyselyProjectUpdateTransaction(tx: Transaction<Database>, backend: 'sqlite' | 'postgres', rawOwner: string, clock: Clock = nowUtc): ProjectUpdateTransaction {
  const owner = backend === 'sqlite' ? rawOwner.replaceAll('-', '') : rawOwner
  const repository = new SqlProjectRepository(tx, owner, backend, clock)
  const sameOwner = (requested: string) => { if (requested !== rawOwner) throw new Error('事务身份不一致') }
  return {
    async getOwned(requested, id) { sameOwner(requested); return repository.get(id) },
    async updateIfVersion(requested, id, version, fields) {
      sameOwner(requested)
      if (!await repository.update(id, version, fields)) return null
      return repository.get(id)
    },
    async updateFileStoragePrefixes(requested, id, oldPrefix, newPrefix) {
      sameOwner(requested)
      // 不使用LIKE：名称中的百分号/下划线必须按字面前缀处理。
      const length = [...oldPrefix].length
      await sql`UPDATE files SET storage_key=${newPrefix} || substr(storage_key, ${length + 1})
        WHERE user_id=${owner} AND project_id=${id} AND substr(storage_key,1,${length})=${oldPrefix}`.execute(tx)
    },
    recordUndo: record => recordForwardUndoOperation(tx, backend, record, clock),
  }
}
