import type { Pool, PoolClient } from 'pg'
import { normalizeOwnerId } from '../../../adapters/owner-context.js'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { normalizeOnboardingState } from '../onboarding.js'
import type { RegistrationSeedPlan, RegistrationSeedPorts } from '../registration-seed.js'
import { createPostgresRegistrationSeedFileWriter } from '../../files/file-upload-postgres.js'

interface SeedStateRow { state: unknown }
interface InsertedId { id: number | string }

async function loadSeedState(client: PoolClient, ownerId: string): Promise<Record<string, unknown>> {
  const emptyState = {
    seed: { seeded: false, project_id: null, project_name: null },
    guide: {
      enabled: false, version: 1, current_step: 'locale', completed_steps: [],
      dismissed: false, completed_at: null,
    },
  }
  await client.query(
    `INSERT INTO onboarding_state (user_id,state,created_at,updated_at)
     VALUES ($1,$2::json,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO NOTHING`,
    [ownerId, JSON.stringify(emptyState)],
  )
  const result = await client.query<SeedStateRow>(
    'SELECT state FROM onboarding_state WHERE user_id=$1 FOR UPDATE', [ownerId],
  )
  return normalizeOnboardingState(result.rows[0]?.state)
}

async function applySeed(
  client: PoolClient,
  ownerId: string,
  plan: RegistrationSeedPlan,
  writeFiles: ReturnType<typeof createPostgresRegistrationSeedFileWriter>,
): Promise<{ status: 'applied'; fileLifecycle: { fileIds: number[]; finalize(): Promise<void>; rollback(): Promise<void> } } | { status: 'already_seeded' }> {
  const state = await loadSeedState(client, ownerId)
  const seedState = state.seed && typeof state.seed === 'object' && !Array.isArray(state.seed)
    ? state.seed as Record<string, unknown>
    : {}
  if (seedState.seeded) return { status: 'already_seeded' }

  const insertedProject = await client.query<InsertedId>(
    `INSERT INTO projects (
       user_id,name,summary,contact_name,status,start_date,deadline,color,progress,
       stages_json,current_stage,priority,version,archived,done_at,created_at,updated_at,deleted_at
     ) VALUES ($1,$2,NULL,NULL,$3,$4,$5,NULL,0,$6,$7,NULL,1,FALSE,NULL,
       CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL) RETURNING id`,
    [ownerId, plan.project.name, plan.project.status, plan.project.startDate,
      plan.project.deadline, JSON.stringify(plan.project.stages), plan.project.currentStage],
  )
  const projectId = insertedProject.rows[0]?.id
  if (projectId === undefined) throw new Error('引导项目创建后未返回标识')
  const numericProjectId = Number(projectId)
  if (!Number.isSafeInteger(numericProjectId) || numericProjectId < 1)
    throw new Error('引导项目标识无效')

  await client.query(
    `INSERT INTO calendar_events (user_id,title,date,type,project_id,version,created_at,deleted_at)
     VALUES ($1,$2,$3,$4,$5,1,CURRENT_TIMESTAMP,NULL)`,
    [ownerId, plan.calendarEvent.title, plan.calendarEvent.date, plan.calendarEvent.type, numericProjectId],
  )
  const files = await writeFiles(client, ownerId, numericProjectId, plan.files.map((file) => ({
    space: file.space,
    displayName: file.displayName,
    ext: file.ext,
    mimeType: file.mimeType,
    data: file.data,
  })))
  try {
    const nextState = normalizeOnboardingState({
      ...state,
      seed: { ...seedState, ...plan.seedState, project_id: numericProjectId },
      guide: plan.guideState,
    })
    await client.query(
      `UPDATE onboarding_state SET state=$2::json,updated_at=CURRENT_TIMESTAMP WHERE user_id=$1`,
      [ownerId, JSON.stringify(nextState)],
    )
    return { status: 'applied', fileLifecycle: files }
  } catch (error) {
    await files.rollback()
    throw error
  }
}

/** One PostgreSQL transaction for the seed gate, project, calendar, Local files and onboarding state. */
export function createPostgresRegistrationSeedOperations(
  pool: Pick<Pool, 'connect'>,
  options: { storageRoot: string; defaultLimitBytes?: number | null; onFailure?(error: unknown): void },
): RegistrationSeedPorts['applySeed'] {
  const writeFiles = createPostgresRegistrationSeedFileWriter(options.storageRoot, options.defaultLimitBytes ?? null)
  return async (rawOwnerId, plan) => {
    const ownerId = normalizeOwnerId(rawOwnerId)
    const client = await pool.connect()
    let fileLifecycle: { finalize(): Promise<void>; rollback(): Promise<void> } | null = null
    let committed = false
    try {
      await client.query('BEGIN')
      const result = await applySeed(client, ownerId, plan, writeFiles)
      if (result.status === 'already_seeded') {
        await client.query('COMMIT')
        committed = true
        return result.status
      }
      fileLifecycle = result.fileLifecycle
      await client.query('COMMIT')
      committed = true
      await result.fileLifecycle.finalize().catch(() => undefined)
      return 'applied'
    } catch (error) {
      if (!committed) {
        await client.query('ROLLBACK').catch(() => undefined)
        await fileLifecycle?.rollback()
      }
      try { options.onFailure?.(error) } catch { /* best-effort diagnostics */ }
      throw error
    } finally {
      client.release()
    }
  }
}
