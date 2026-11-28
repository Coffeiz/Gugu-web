import { createByokListService, type ByokEnvelope } from '@gugu/core/agent/config'
import { createProviderCapabilityPreview } from '@gugu/core/byok/capabilities-preview'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { Pool } from 'pg'
import { resolveConfigOverridePath } from '../../adapters/config/config-override-file.js'
import { withPostgresTransaction } from '../../adapters/database/postgres-transaction.js'
import { createCredentialCreator, createCredentialDeletion, createPostgresByokListReader, createCredentialPatch } from './store.js'
import { createByokGateReader } from './policy.js'
import { createByokMediaCapabilityProbeRunner, createByokMediaCapabilityProbe } from './checks/capabilities.js'
import { createByokModelsPreviewFetcher, createCredentialModelsPreview } from './checks/models.js'
import { createByokCredentialTestProbe, createCredentialSavedTest, createCredentialTestPreview } from './checks/connection.js'
import { createConfiguredByokEnvelope } from './crypto.js'

export function createByokService(db: SqlDataRuntime['db'], pool: Pool, env: NodeJS.ProcessEnv) {
  const enabled = createByokGateReader(resolveConfigOverridePath(env), env)
  const encrypt = (value: string, allowEmpty: boolean) => createConfiguredByokEnvelope(env).encrypt(value, allowEmpty)
  const decrypt = (row: ByokEnvelope) => createConfiguredByokEnvelope(env).decrypt({
    ciphertext: row.encrypted_value,
    nonce: row.nonce,
    encryptedDataKey: row.encrypted_data_key,
    keyVersion: row.key_version,
  })
  const test = { enabled, decrypt, probe: createByokCredentialTestProbe(env) }
  return {
    credentialCreate: { create: createCredentialCreator({
      enabled, encrypt,
      transaction: work => withPostgresTransaction(pool, client =>
        work((sql, values) => client.query<Record<string, unknown>>(sql, [...values]))),
    }) },
    credentialList: { list: createByokListService({
      enabled, readOwned: createPostgresByokListReader(pool),
      verifyEnvelope: async row => { await decrypt(row) },
    }) },
    credentialDelete: { remove: createCredentialDeletion(db, enabled) },
    credentialPatch: { patch: createCredentialPatch(db, { enabled, encrypt, decrypt }) },
    credentialModelsPreview: { preview: createCredentialModelsPreview(db, {
      enabled, decrypt, fetchModels: createByokModelsPreviewFetcher(env),
    }) },
    credentialTestPreview: {
      preview: createCredentialTestPreview(db, test),
      savedTest: createCredentialSavedTest(db, test),
    },
    credentialMediaProbe: { probe: createByokMediaCapabilityProbe(db, {
      enabled, decrypt, probe: createByokMediaCapabilityProbeRunner(env),
    }) },
    providerCapabilityPreview: { preview: createProviderCapabilityPreview(enabled) },
  }
}
