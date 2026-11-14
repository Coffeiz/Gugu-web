import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import type { OnboardingStore } from '../onboarding.js'
import { normalizeOnboardingState } from '../onboarding.js'

interface OnboardingRow {
  state: unknown
}

const emptyState = JSON.stringify({
  seed: { seeded: false, project_id: null, project_name: null },
  guide: {
    enabled: false,
    version: 1,
    current_step: 'locale',
    completed_steps: [],
    dismissed: false,
    completed_at: null,
  },
})

async function loadOrCreate(client: PoolClient, ownerId: string, lock: boolean): Promise<Record<string, unknown>> {
  await client.query(
    `INSERT INTO onboarding_state (user_id, state, created_at, updated_at)
     VALUES ($1, $2::json, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO NOTHING`,
    [ownerId, emptyState],
  )
  const result = await client.query<OnboardingRow & Record<string, unknown>>(
    `SELECT state FROM onboarding_state WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [ownerId],
  )
  return normalizeOnboardingState(result.rows[0]?.state)
}

async function updateOnboardingGuide(
  pool: Pick<Pool, 'connect'>,
  ownerId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withPostgresTransaction(pool, async (client) => {
    const state = await loadOrCreate(client, ownerId, true)
    const guide = state.guide && typeof state.guide === 'object' && !Array.isArray(state.guide)
      ? state.guide as Record<string, unknown>
      : {}
    const next = normalizeOnboardingState({
      ...state,
      guide: { ...guide, ...patch },
    })
    await client.query(
      `UPDATE onboarding_state
       SET state = $2::json, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [ownerId, JSON.stringify(next)],
    )
    return next
  })
}

/** PostgreSQL owner-scoped persistence for Python-compatible onboarding state. */
export function createPostgresOnboardingStore(pool: Pick<Pool, 'connect'>): OnboardingStore {
  return {
    getState(ownerId) {
      return withPostgresTransaction(pool, (client) => loadOrCreate(client, ownerId, false))
    },
    updateGuide(ownerId, patch) { return updateOnboardingGuide(pool, ownerId, patch) },
  }
}
