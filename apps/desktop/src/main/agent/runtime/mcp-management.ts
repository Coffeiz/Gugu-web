import { randomUUID } from 'node:crypto'
import { CoreError } from '#core-source/contracts/index.js'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import { isPublicAddress } from '#core-source/agent/providers/transport/network.js'
import type { NodeProviderTransportOptions } from '#core-source/agent/providers/transport/node.js'
import { createSqliteToolConfirmation } from '#core-source/agent/interactions/sqlite-confirmation.js'
import { stageSqliteMcpCredential } from '#core-source/agent/interactions/sqlite-credential.js'
import { createMcpManagementTool, createMcpManagementEditOperations, createMcpManagementRemoveOperations, createMcpManagementCreateOperations, describeMcpManagementUpdate } from '#core-source/agent/tools/mcp-management.js'
import { testMcp, type McpConfig } from '#core-source/mcp/desktop-connection.js'
import { createDesktopMcpCrypto } from '#core-source/mcp/desktop-crypto.js'
import type { createDesktopMcpAgentRuntime } from '#core-source/mcp/desktop-agent-runtime.js'
import { validateMcpEndpoint } from '#core-source/mcp/server-config.js'
import { createMcpServerConfigLister } from '#core-source/mcp/server-list.js'
import { desktopMcp, desktopMcpMaxServers } from '#core-source/runtime/desktop-resources.js'

export function createDesktopMcpManagement(options: {
  core: SqlDataRuntime
  ownerId: string
  databasePath: string
  interactive: boolean
  authorizeWrite: Parameters<typeof createSqliteToolConfirmation>[1]
  resolveProxy: NodeProviderTransportOptions['resolveProxy']
  getRuntime: () => ReturnType<typeof createDesktopMcpAgentRuntime>
}) {
  const { core, ownerId, databasePath, interactive, authorizeWrite, resolveProxy, getRuntime } = options
  const { db } = core
  const mcpCrypto = createDesktopMcpCrypto(databasePath)
  const validateMcpToolEndpoint = (endpoint: string) => validateMcpEndpoint(endpoint, isPublicAddress)
  const mcpAddConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'add_mcp_server',
    async (_tx, identity, input, snapshot): Promise<string> => {
      if (!mcpAdd) throw new CoreError('conflict', 'MCP 创建确认不可用')
      return mcpAdd.describe(identity, input, snapshot)
    })
  const mcpAdd = core.receipts && interactive ? createMcpManagementCreateOperations(core, {
    settings: () => ({ default_timeout_seconds: 30, max_tools_per_server: 64, max_servers_per_user: desktopMcpMaxServers }),
    id: randomUUID, encrypt: mcpCrypto.encrypt, validateEndpoint: validateMcpToolEndpoint,
    authorize: authorizeWrite, confirmation: mcpAddConfirmation, stageCredential: stageSqliteMcpCredential,
  }) : undefined
  const mcpUpdateConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'update_mcp_server',
    (tx, identity, input, snapshot) => describeMcpManagementUpdate(tx, identity, input, snapshot, 'sqlite', validateMcpToolEndpoint))
  const mcpRemoveConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'remove_mcp_server',
    async (tx, identity, input, snapshot): Promise<string> => {
      if (!mcpRemove) throw new CoreError('conflict', 'MCP 删除确认不可用')
      return mcpRemove.describe(tx, identity, input, snapshot)
    })
  const mcpRemove = core.receipts && interactive ? createMcpManagementRemoveOperations(core, {
    crypto: mcpCrypto, maxTools: 64,
  }, { confirmation: mcpRemoveConfirmation, async invalidate() {} }) : undefined
  const management = createMcpManagementTool({
    list: createMcpServerConfigLister(db, 'sqlite'), decrypt: mcpCrypto.decrypt, enabled: () => true,
    async testConnection(owner, id, signal) {
      if (owner !== ownerId) return { ok: false, errorKind: 'configuration' }
      const config = await desktopMcp(db, owner, mcpCrypto).config(id) as McpConfig
      const result = await testMcp(config, resolveProxy, { allowLoopback: false, signal })
      return result.ok ? { ok: true, toolNames: result.tools } : { ok: false, errorKind: result.errorKind }
    },
    state: (owner, id): ReturnType<ReturnType<typeof createDesktopMcpAgentRuntime>['state']> => getRuntime().state(owner, id),
  }, mcpRemove, core.receipts && interactive ? createMcpManagementEditOperations(core, {
    decrypt: mcpCrypto.decrypt,
    authorize: authorizeWrite,
    update: { crypto: mcpCrypto, maxTools: 64, confirmation: mcpUpdateConfirmation,
      validateEndpoint: validateMcpToolEndpoint, credential: { id: randomUUID, stage: stageSqliteMcpCredential } },
    async afterCommit(owner, id, reload, signal) {
      if (!reload) return
      signal.throwIfAborted()
      await getRuntime().directory(owner)
      signal.throwIfAborted()
      const { state } = await getRuntime().state(owner, id)
      return { ok: state === 'ok', state, error: null }
    },
  }) : undefined, mcpAdd)
  return { management, mcpCrypto, mcpAddConfirmation, mcpUpdateConfirmation, mcpRemoveConfirmation }
}
