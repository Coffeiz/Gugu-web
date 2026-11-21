import { desktopMcpConfigDigest } from '../mcp/desktop-agent-runtime.js'
import { createMcpSnapshotStore } from '../mcp/snapshot-store.js'
import { createHash, randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { z } from 'zod'
import { CoreError } from '../contracts/index.js'
import { createUserSkillManager, UserSkillValidationError } from '../agent/skills/user-management.js'
import { createUserSkillDeletion } from '../agent/skills/user-delete.js'
import { createMcpServerCreator } from '../mcp/server-create.js'
import { createMcpServerMutations, type McpEnvelopeCrypto } from '../mcp/server-mutations.js'
import { createMcpServerConfigLister } from '../mcp/server-list.js'

const skill = z.strictObject({
  name: z.string().max(120), description_short: z.string().max(100),
  description_long: z.string().max(500).nullable().default(null),
  category: z.string().max(32).default('personal'), body: z.string().max(20_000),
  related_tools: z.array(z.string().max(128)).max(32).default([]), enabled: z.boolean().default(true),
})
const mcp = z.strictObject({
  name: z.string().min(1).max(64), endpoint: z.url({ protocol: /^https?$/ }).max(1000).refine(value => {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
  }),
  transport: z.literal('http').default('http'), enabled: z.boolean().default(true),
  confirm_mode: z.enum(['auto', 'confirm_all']).default('confirm_all'),
  timeout_seconds: z.number().int().min(1).max(300).default(30),
  credential_slots: z.array(z.looseObject({ target: z.literal('header') })).max(16).default([]),
  credential_values: z.record(z.string(), z.string().max(1024)).default({}),
  tool_allowlist: z.array(z.string().min(1).max(128)).max(64).default([]),
})
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new CoreError('invalid_request', '资源配置参数无效')
  return result.data
}

export function createDesktopSkillManager<DB>(db: Kysely<DB>, knownTools: ReadonlySet<string> = new Set()) {
  return createUserSkillManager(db, 'sqlite', {
    knownTools: async () => knownTools,
    digest: text => createHash('sha256').update(text).digest('hex'),
    publish: async () => {},
    async allocateSequence(tx) {
      const { rows: [row] } = await sql<{ value: string }>`INSERT INTO core_runtime_meta(key,value)
        VALUES('desktop_skill_sequence','2') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1 RETURNING value`.execute(tx)
      return Number(row?.value)
    },
  })
}

export function desktopSkills<DB>(db: Kysely<DB>, owner: string, knownTools?: ReadonlySet<string>) {
  const manager = createDesktopSkillManager(db, knownTools)
  return {
    async list(offset: number) {
      const rows = await manager.list(owner, { limit: 2, offset })
      return { skills: rows.slice(0, 1), nextOffset: rows.length > 1 ? offset + 1 : null }
    },
    async write(id: string | undefined, value: unknown) {
      try {
        const fields = parse(id ? skill.partial() : skill, value)
        if (JSON.stringify(fields).length > 20_000 || Buffer.byteLength(JSON.stringify(fields)) > 48_000)
          throw new CoreError('invalid_request', '技能内容超出桌面传输大小限制')
        const save = id
          ? await manager.prepareUpdate(owner, id, { ...fields, managed_by: 'user' })
          : await manager.prepareCreate(owner, { ...parse(skill, value), managed_by: 'user' })
        return { id: (await save(db)).id }
      } catch (error) {
        if (error instanceof UserSkillValidationError) throw new CoreError('invalid_request', '技能内容或关联工具无效')
        throw error
      }
    },
    remove: async (id: string) => { await createUserSkillDeletion(db, 'sqlite', async () => {})(owner, id); return null },
  }
}

export const desktopMcpMaxServers = null
export function desktopMcp<DB>(db: Kysely<DB>, owner: string, crypto: McpEnvelopeCrypto) {
  const listConfig = createMcpServerConfigLister(db, 'sqlite')
  const snapshots = createMcpSnapshotStore(db, 'sqlite', async (id, connection) =>
    desktopMcpConfigDigest((await listConfig(id, connection)).filter(row => row.enabled)))
  const mutations = createMcpServerMutations(db, { crypto, maxTools: 64 }, 'sqlite')
  const create = createMcpServerCreator(db, { maxServersPerUser: desktopMcpMaxServers, id: randomUUID, encrypt: crypto.encrypt }, 'sqlite')
  return {
    async list(offset?: number) {
      const rows = await listConfig(owner)
      const snapshot = await snapshots.read(owner)
      const tools = snapshot?.digest === desktopMcpConfigDigest(rows.filter(row => row.enabled)) ? snapshot.tools : null
      const items = rows.map(row => {
        const names = tools?.filter(tool => tool.server_id === row.id).map(tool => tool.name).sort() ?? []
        return {
          id: row.id, name: row.name, scope: row.scope, transport: row.transport, endpoint: '', command: '',
          credential_slots: row.credential_slots, has_credentials: Boolean(row.encrypted_credentials),
          enabled: Boolean(row.enabled), confirm_mode: row.confirm_mode, timeout_seconds: row.timeout_seconds,
          tool_allowlist: row.tool_allowlist, state: row.enabled ? (tools ? 'ok' : 'unloaded') : 'disabled',
          loaded_tool_count: names.length, loaded_tool_names: names,
          config_digest: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
        }
      })
      if (offset === undefined) return { enabled: true, max_servers: desktopMcpMaxServers, items }
      const page: typeof items = []
      let bytes = 0
      for (const item of items.slice(offset)) {
        bytes += Buffer.byteLength(JSON.stringify(item)) + 1
        if (page.length && bytes > 48_000) break
        page.push(item)
      }
      const next = offset + page.length
      return { enabled: true, max_servers: desktopMcpMaxServers, items: page, nextOffset: next < items.length ? next : null }
    },
    async config(id: string) {
      const [row] = await listConfig(owner, db, id)
      if (!row) throw new CoreError('not_found', 'MCP 服务不存在')
      const decode = (ciphertext: string, nonce: string, encryptedDataKey: string, keyVersion: number) =>
        crypto.decrypt({ ciphertext, nonce, encryptedDataKey, keyVersion })
      const endpoint = row.encrypted_endpoint
        ? await decode(row.encrypted_endpoint, row.endpoint_nonce, row.encrypted_endpoint_key, row.endpoint_key_version)
        : row.endpoint
      const credential_values: unknown = row.encrypted_credentials
        ? JSON.parse(await decode(row.encrypted_credentials, row.credentials_nonce, row.encrypted_credentials_key, row.credentials_key_version))
        : {}
      return { endpoint, config_digest: createHash('sha256').update(JSON.stringify(row)).digest('hex'), credential_values, credential_slots: row.credential_slots, timeout_seconds: row.timeout_seconds, tool_allowlist: row.tool_allowlist }
    },
    async write(id: string | undefined, value: unknown) {
      if (id) await mutations.updateStored(db, owner, id, parse(mcp.partial(), value))
      else return { id: (await create(owner, { ...parse(mcp, value), command: '' })).id }
      return { id }
    },
    remove: (id: string) => mutations.remove(owner, id),
  }
}
