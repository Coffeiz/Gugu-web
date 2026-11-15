import { sql, type Kysely, type Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { PreferenceDocumentStore } from './service.js'

/** 读写可信 owner 的偏好文档；连接生命周期由 Host 持有。 */
export function createKyselyPreferenceDocumentStore<DB>(db: Kysely<DB> | Transaction<DB>, backend: 'sqlite' | 'postgres'): PreferenceDocumentStore {
  const ownerKey = (ownerId: string) => {
    const normalized = dataContext(ownerId).ownerId
    return backend === 'sqlite' ? normalized.replaceAll('-', '') : normalized
  }
  return {
    async read(ownerId) {
      const owner = ownerKey(ownerId)
      const result = await sql<{ data_json: string }>`SELECT data_json FROM user_preferences WHERE user_id=${owner}`.execute(db)
      return result.rows[0]?.data_json ?? null
    },
    async write(ownerId, data) {
      const owner = ownerKey(ownerId)
      const encoded = JSON.stringify(data)
      await sql`INSERT INTO user_preferences (user_id,data_json,updated_at)
        VALUES (${owner},${encoded},CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) DO UPDATE SET data_json=excluded.data_json,updated_at=CURRENT_TIMESTAMP`.execute(db)
    },
  }
}
