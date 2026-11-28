import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { normalizeOnboardingState, type OnboardingStore } from './state.js'

/** 单个 owner 的状态读写在同一数据库事务内完成。 */
export function createKyselyOnboardingStore<DB>(db: Kysely<DB>, backend: 'postgres' | 'sqlite', options: { enableNewGuide?: boolean } = {}): OnboardingStore {
  const ownerKey = (ownerId: string) => {
    const id = dataContext(ownerId).ownerId
    return backend === 'sqlite' ? id.replaceAll('-', '') : id
  }
  async function execute(ownerId: string, patch?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const owner = ownerKey(ownerId)
    return db.transaction().execute(async (tx) => {
      const empty = JSON.stringify(normalizeOnboardingState(options.enableNewGuide ? { guide: { enabled: true } } : {}))
      if (backend === 'postgres') {
        await sql`INSERT INTO onboarding_state(user_id,state,created_at,updated_at)
          VALUES (${owner},${empty}::json,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (user_id) DO NOTHING`.execute(tx)
      } else {
        await sql`INSERT INTO onboarding_state(user_id,state,created_at,updated_at)
          VALUES (${owner},${empty},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (user_id) DO NOTHING`.execute(tx)
      }
      const rows = backend === 'postgres'
        ? await sql<{ state: unknown }>`SELECT state FROM onboarding_state WHERE user_id=${owner} FOR UPDATE`.execute(tx)
        : await sql<{ state: unknown }>`SELECT state FROM onboarding_state WHERE user_id=${owner}`.execute(tx)
      const raw = rows.rows[0]?.state
      const state = normalizeOnboardingState(typeof raw === 'string' ? JSON.parse(raw) : raw)
      if (!patch) return state
      const next = normalizeOnboardingState({ ...state, guide: { ...(state.guide as Record<string, unknown>), ...patch } })
      const encoded = JSON.stringify(next)
      if (backend === 'postgres') {
        await sql`UPDATE onboarding_state SET state=${encoded}::json,updated_at=CURRENT_TIMESTAMP WHERE user_id=${owner}`.execute(tx)
      } else {
        await sql`UPDATE onboarding_state SET state=${encoded},updated_at=CURRENT_TIMESTAMP WHERE user_id=${owner}`.execute(tx)
      }
      return next
    })
  }
  return { getState: (owner) => execute(owner), updateGuide: (owner, patch) => execute(owner, patch) }
}
