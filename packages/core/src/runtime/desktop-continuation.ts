import { sql, type Kysely, type Transaction } from 'kysely'
import { createAgentRunCodec, sameRunIdentity } from '../agent/run/codec.js'
import { terminalRunStates } from '../agent/run/lifecycle.js'
import { sqliteAgentRunScope } from '../agent/run/sqlite-store.js'
import type { CanonicalRunContext, RunCheckpoint, RunIdentity } from '../agent/models.js'
import type { ProviderContinuationStore } from '../agent/providers/runtime.js'
import type { Database } from '../data/schema.js'

type Scope = Parameters<ProviderContinuationStore['save']>[0]
type Value = Parameters<ProviderContinuationStore['save']>[2]
type Stored = Omit<Scope, 'identity'> & { expiresAt: number; value: Value }

/** 私有 Provider 状态仅随引用它的检查点提交，未提交的状态不会覆盖原有回执。 */
export function createDesktopContinuationStore(db: Kysely<Database>, secret: string) {
  const codec = createAgentRunCodec(secret)
  let pending: { identity: RunIdentity; reference: string; stored: Stored } | null = null
  function matches(stored: Stored, scope: Scope) {
    return stored.expiresAt > Date.now() && stored.modelIdentity === scope.modelIdentity
      && stored.accessScopeHash === scope.accessScopeHash
  }
  const store: ProviderContinuationStore = {
    async save(scope, reference, value, ttlMs) {
      pending = { identity: { ...scope.identity }, reference, stored: {
        modelIdentity: scope.modelIdentity, accessScopeHash: scope.accessScopeHash,
        expiresAt: Date.now() + ttlMs, value: structuredClone(value),
      } }
    },
    async read(scope, reference) {
      const { owner, session, run } = sqliteAgentRunScope(scope.identity)
      const { rows: [row] } = await sql<{ nonce: Uint8Array; payload: Uint8Array }>`
        SELECT nonce,payload FROM desktop_agent_continuations
        WHERE user_id=${owner} AND session_id=${session} AND run_id=${run}
          AND reference=${reference} AND expires_at_ms>${Date.now()}
      `.execute(db)
      if (!row) return null
      const stored = codec.decryptContinuation<Stored>(scope.identity, reference, row.nonce, row.payload)
      return matches(stored, scope) ? stored.value : null
    },
  }
  async function persist(tx: Transaction<Database>, identity: RunIdentity,
    next: RunCheckpoint<CanonicalRunContext>, previous: RunCheckpoint<CanonicalRunContext> | null) {
    const reference = next.context?.continuationRef
    const { owner, session, run } = sqliteAgentRunScope(identity)
    if (terminalRunStates.has(next.status)) return
    if (!reference) {
      if (previous?.context?.continuationRef) await sql`DELETE FROM desktop_agent_continuations
        WHERE user_id=${owner} AND session_id=${session} AND run_id=${run}`.execute(tx)
      return
    }
    if (reference === previous?.context?.continuationRef) return
    const context = next.context!
    if (pending?.reference !== reference || !matches(pending.stored, context)
      || !sameRunIdentity(pending.identity, identity)) throw new Error('本机模型续接状态与检查点不匹配')
    const { nonce, payload } = codec.encryptContinuation(identity, reference, pending.stored)
    await sql`INSERT INTO desktop_agent_continuations (user_id,session_id,run_id,reference,expires_at_ms,nonce,payload)
      VALUES(${owner},${session},${run},${reference},${pending.stored.expiresAt},${nonce},${payload})
      ON CONFLICT (user_id,session_id,run_id) DO UPDATE SET reference=excluded.reference,
        expires_at_ms=excluded.expires_at_ms,nonce=excluded.nonce,payload=excluded.payload`.execute(tx)
  }
  return { store, persist }
}
