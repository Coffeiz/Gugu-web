import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { embedRagQuery, prepareMemory } from '@gugu/core/agent/rag'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { createPostgresAgentMemorySearchPort, createWebOwnerMemorySearchPort } from '../../src/domains/agent-sessions/tools/agent-memory-search.js'
import { createPostgresAgentImMemoryContextReader, createPostgresAgentMemoryScopeResolver } from '../../src/domains/agent-sessions/tools/agent-memory-scopes.js'
import { createLocalAgentMemoryRagStore } from '../../src/domains/agent-sessions/tools/agent-rag-memory-store.js'
import { createPostgresAgentEmbeddingSettingsResolver, createPostgresAgentRagEmbeddingPort } from '../../src/domains/agent-sessions/tools/agent-rag-vectors.js'

test('IM memory context 从当前 owner 会话和本次 run 的用户消息读取，并对缺失身份 fail closed', async () => {
  const owner = 'f17421a3-8520-4c8b-92e5-736882f4bd82'
  const calls: Array<{ text: string; values: unknown[] }> = []
  let row: Record<string, unknown> | null = {
    platform: 'qq', chat_type: 'group', chat_id: 'group-7', channel_id: 'channel-9',
    owner_platform_user_id: 'owner-user', platform_user_id: 'member-3', inbound_message_id: '501',
  }
  const pool = { async query(text: string, values: unknown[]) {
    calls.push({ text, values })
    return { rows: row ? [row] : [] }
  } } as unknown as Parameters<typeof createPostgresAgentImMemoryContextReader>[0]
  const read = createPostgresAgentImMemoryContextReader(pool)
  const identity = { ownerId: owner, sessionId: '41', runId: 'run-8' }
  const signal = new AbortController().signal

  assert.deepEqual(await read(identity, signal), {
    platform: 'qq', chatType: 'group', chatId: 'group-7', channelId: 'channel-9', role: 'member', platformUserId: 'member-3',
  })
  assert.deepEqual(calls[0]?.values, [owner, '41', 'run-8'])
  assert.match(calls[0]?.text ?? '', /s\.user_id\s*=\s*\$1/u)
  assert.match(calls[0]?.text ?? '', /s\.active_run_id\s*=\s*\$3/u)
  assert.match(calls[0]?.text ?? '', /run_id\s*=\s*\$3/u)

  row = { ...row, platform_user_id: 'owner-user' }
  assert.equal((await read(identity, signal))?.role, 'owner')
  row = { ...row, platform: 'web', chat_type: null, chat_id: null, channel_id: null,
    owner_platform_user_id: null, platform_user_id: null, inbound_message_id: null }
  assert.equal(await read(identity, signal), null)

  row = { platform: 'qq', chat_type: 'group', chat_id: 'group-7', channel_id: 'channel-9',
    owner_platform_user_id: 'owner-user', platform_user_id: null, inbound_message_id: null }
  await assert.rejects(() => read(identity, signal), /记忆检索上下文不可用/u)

  const cancelled = new AbortController()
  cancelled.abort(new Error('取消记忆检索'))
  const queryCount = calls.length
  await assert.rejects(() => read(identity, cancelled.signal), /取消记忆检索/u)
  assert.equal(calls.length, queryCount)
})

test('Web owner memory 经受限 Host FS、Core RAG 与实际工具 registry dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-memory-tool-'))
  const storageRoot = join(directory, 'storage')
  const opened = await (async () => {
    await initializeSqlite(join(directory, 'core.db'))
    return openSqliteRuntime(join(directory, 'core.db'))
  })()
  const { runtime: core, ownerId: owner } = opened
  try {
    const memoryDirectory = join(storageRoot, owner, '.agent', 'rag', 'memory')
    await mkdir(memoryDirectory, { recursive: true })
    await writeFile(join(memoryDirectory, 'index.json'), JSON.stringify({ schema_version: 1, documents: [
      { document_id: 'profile:0', parent_document_id: 'memory:profile', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '用户画像', summary: 'coffee 群消息分词测试', content: 'coffee after lunch 群消息分词测试',
        version: 'profile-v1', scope: { owner_user_id: owner, scope_type: 'owner', scope_id: '' }, metadata: {} },
      { document_id: 'foreign:0', parent_document_id: 'memory:foreign', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '其他用户', summary: '', content: 'foreign coffee',
        version: 'profile-v1', scope: { owner_user_id: '08a80873-5266-43b9-a27c-d288b602a9cb', scope_type: 'owner', scope_id: '' }, metadata: {} },
    ] }), 'utf8')
    let allowed = true, snapshotReads = 0
    const identity = { ownerId: owner, sessionId: '1', runId: 'memory-tool' }
    const registry = createAgentToolRegistry({ core,
      authorize: async (current, name) => allowed && current.ownerId === owner && name === 'search_memory',
      memorySearch: createWebOwnerMemorySearchPort(core, {
        storageRoot,
        authorize: async current => allowed && current.ownerId === owner,
        async snapshot() { snapshotReads++; return { revision: 'snapshot-v1', text: '' } },
      }),
    })
    assert.equal((await registry.capabilities(identity)).some(tool => tool.name === 'search_memory'), true)
    const call = { id: 'search', name: 'search_memory', input: { query: 'coffee', source: 'profile', owner_id: 'forged-owner' } }
    const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不应执行宿主命令') } }
    const found = await registry.tools.dispatch(call, scope)
    assert.equal(found.kind, 'completed')
    if (found.kind === 'completed') {
      assert.equal(found.successful, true)
      assert.deepEqual((found.value as { results: Array<Record<string, unknown>> }).results.map(row => row.source_id), ['profile'])
      assert.match(JSON.stringify(found.value), /coffee after lunch/u)
      assert.equal((found.value as { results: Array<Record<string, unknown>> }).results[0]?.source, 'memory')
    }
    assert.equal(snapshotReads, 1)

    const chineseCall = await registry.tools.dispatch({ id: 'jieba-search', name: 'search_memory',
      input: { query: '群消息' } }, scope)
    assert.equal(chineseCall.kind, 'completed')
    if (chineseCall.kind === 'completed') {
      assert.equal(chineseCall.successful, true)
      assert.match(JSON.stringify(chineseCall.value), /coffee after lunch 群消息分词测试/u)
    }

    await writeFile(join(storageRoot, owner, '.agent', 'memory_vec.json'), JSON.stringify({
      'rag:memory:profile:profile-v1:0': { t: 'synthetic:embedding-v1:2', v: [1, 0] },
    }), 'utf8')
    let embeddingCalled = false, credentialReads = 0
    const embedding = createPostgresAgentRagEmbeddingPort({ async query(_text: string, values: unknown[]) {
      credentialReads++
      assert.deepEqual(values, [owner])
      return { rows: [{ provider: 'synthetic', base_url: 'https://embedding.example/v1', model: 'embedding-v1', dimensions: 2,
        encrypted_value: 'cipher', nonce: 'nonce', encrypted_data_key: 'wrapped', key_version: 1 }] }
    } } as unknown as Parameters<typeof createPostgresAgentRagEmbeddingPort>[0], {
      enabled: async () => allowed,
      async decrypt(row) { assert.equal(row.encrypted_value, 'cipher'); return 'synthetic-secret' },
      createTransport() {
        return { request: async (_request: unknown, signal: AbortSignal) => {
          signal.throwIfAborted()
          embeddingCalled = true
          return { status: 200, headers: {}, body: (async function* () {
            yield new TextEncoder().encode(JSON.stringify({ data: [{ embedding: [1, 0] }] }))
          })(), cancel: async () => {} }
        } }
      },
    })
    const vectorRegistry = createAgentToolRegistry({ core,
      authorize: async (current, name) => current.ownerId === owner && name === 'search_memory',
      memorySearch: createWebOwnerMemorySearchPort(core, {
        storageRoot,
        authorize: async current => current.ownerId === owner,
        async snapshot() { return { revision: 'snapshot-v1', text: '' } },
        embedding,
      }),
    })
    const vectorResult = await vectorRegistry.tools.dispatch({ ...call, id: 'vector-search' }, scope)
    assert.equal(vectorResult.kind === 'completed' && vectorResult.successful, true)
    if (vectorResult.kind === 'completed') {
      assert.equal((vectorResult.value as { strategy: string }).strategy, 'hybrid')
      assert.deepEqual((vectorResult.value as { results: Array<{ source_id: string }> }).results.map(row => row.source_id), ['profile'])
    }
    assert.equal(embeddingCalled, true)
    assert.equal(credentialReads, 1)
    assert.doesNotMatch(JSON.stringify(vectorResult), /synthetic-secret/u)

    const groupScope = await registry.tools.dispatch({ id: 'group', name: 'search_memory', input: { query: 'coffee', scope: 'current_group' } }, scope)
    assert.equal(groupScope.kind === 'completed' && groupScope.successful, true)
    if (groupScope.kind === 'completed') {
      assert.deepEqual((groupScope.value as { results: Array<{ source_id: string }> }).results.map(row => row.source_id), ['profile'])
      assert.doesNotMatch(JSON.stringify(groupScope.value), /foreign coffee/u)
    }

    let scopeAuthorizationChecks = 0
    const midSearchRevocation = await createAgentToolRegistry({ core,
      authorize: async (_current, name) => name === 'search_memory',
      memorySearch: createWebOwnerMemorySearchPort(core, {
        storageRoot,
        async authorize(current) { return current.ownerId === owner && ++scopeAuthorizationChecks === 1 },
        async snapshot() { return { revision: 'snapshot-v1', text: '' } },
      }),
    }).tools.dispatch({ ...call, id: 'revoked-during-search' }, scope)
    assert.equal(scopeAuthorizationChecks, 2)
    assert.equal(midSearchRevocation.kind, 'completed')
    if (midSearchRevocation.kind === 'completed') {
      assert.equal(midSearchRevocation.successful, false)
      assert.equal((midSearchRevocation.value as { error: string }).error, 'RAG 检索授权已撤销')
      assert.doesNotMatch(JSON.stringify(midSearchRevocation.value), /coffee after lunch/u)
    }

    allowed = false
    const revoked = await registry.tools.dispatch({ ...call, id: 'revoked' }, scope)
    assert.equal(revoked.kind, 'completed')
    if (revoked.kind === 'completed') assert.equal(revoked.executed, false)
    assert.equal(snapshotReads, 3)
  } finally {
    await core.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('记忆向量只在 BYOK Host gate 开启后读取并解密当前 owner 的凭据', async () => {
  const owner = 'f17421a3-8520-4c8b-92e5-736882f4bd82'
  let enabled = false, disableDuringDecrypt = false, queries = 0, decryptions = 0
  const pool = { async query(_text: string, values: unknown[]) {
    queries++
    assert.deepEqual(values, [owner])
    return { rows: [{ provider: 'synthetic', base_url: 'https://embedding.example/v1', model: 'embed-v1', dimensions: 2,
      encrypted_value: 'cipher', nonce: 'nonce', encrypted_data_key: 'wrapped', key_version: 1 }] }
  } } as unknown as Parameters<typeof createPostgresAgentEmbeddingSettingsResolver>[0]
  const resolve = createPostgresAgentEmbeddingSettingsResolver(pool, {
    enabled: () => enabled,
    async decrypt(row) {
      decryptions++
      assert.equal(row.encrypted_value, 'cipher')
      if (disableDuringDecrypt) enabled = false
      return 'synthetic-secret'
    },
  })

  assert.equal(await resolve(owner), null)
  assert.equal(queries, 0)
  assert.equal(decryptions, 0)

  enabled = true
  assert.deepEqual(await resolve(owner), {
    provider: 'synthetic', baseUrl: 'https://embedding.example/v1', model: 'embed-v1', apiKey: 'synthetic-secret', dimensions: 2,
    allowLocal: false,
  })
  assert.equal(queries, 1)
  assert.equal(decryptions, 1)

  enabled = true
  disableDuringDecrypt = true
  assert.equal(await resolve(owner), null)
  assert.equal(queries, 2)
  assert.equal(decryptions, 2)
})

test('IM 记忆 scope 从可信上下文和 owner reflection cursor 解析并经过真实工具 dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-memory-im-scope-'))
  const databasePath = join(directory, 'core.db')
  await initializeSqlite(databasePath)
  const { runtime: core, ownerId: owner } = await openSqliteRuntime(databasePath)
  const storageRoot = join(directory, 'storage')
  const identity = { ownerId: owner, sessionId: '1', runId: 'im-memory-scope' }
  try {
    await core.db.schema.createTable('memory_reflection_cursors')
      .addColumn('id', 'integer', column => column.primaryKey().autoIncrement())
      .addColumn('owner_user_id', 'text', column => column.notNull())
      .addColumn('platform', 'text', column => column.notNull())
      .addColumn('bot_id', 'text', column => column.notNull())
      .addColumn('scope_type', 'text', column => column.notNull())
      .addColumn('scope_id', 'text', column => column.notNull())
      .addColumn('scope_version', 'integer')
      .addColumn('updated_at', 'text')
      .execute()
    await core.db.schema.createTable('memory_scope_tombstones')
      .addColumn('id', 'integer', column => column.primaryKey().autoIncrement())
      .addColumn('owner_user_id', 'text', column => column.notNull())
      .addColumn('platform', 'text', column => column.notNull())
      .addColumn('bot_id', 'text', column => column.notNull())
      .addColumn('scope_type', 'text', column => column.notNull())
      .addColumn('scope_id', 'text', column => column.notNull())
      .execute()
    const cursorDb = core.db as unknown as { insertInto(table: string): { values(rows: object[]): { execute(): Promise<unknown> } } }
    await cursorDb.insertInto('memory_reflection_cursors').values([
      { owner_user_id: owner, platform: 'qq', bot_id: 'bot-1', scope_type: 'group', scope_id: 'group-2' },
      { owner_user_id: owner, platform: 'qq', bot_id: 'bot-1', scope_type: 'platform-user', scope_id: 'group-2:member-1' },
      { owner_user_id: owner, platform: 'qq', bot_id: 'bot-1', scope_type: 'platform-user', scope_id: 'group-2:other-member' },
    ]).execute()
    const docs = [{ document_id: 'profile:0', parent_document_id: 'owner', chunk_index: 0,
      chunk_count: 1, source_type: 'memory', source_id: 'profile', title: '私人记忆', summary: '', content: 'coffee private memory',
      version: 'profile-v1', scope: { owner_user_id: owner, scope_type: 'owner', scope_id: '' }, metadata: {} }]
    const ownerMemoryDir = join(storageRoot, owner, '.agent', 'rag', 'memory')
    await mkdir(ownerMemoryDir, { recursive: true })
    await writeFile(join(ownerMemoryDir, 'index.json'), JSON.stringify({ schema_version: 1, documents: docs }), 'utf8')
    const writeScopeFile = async (branch: 'groups' | 'platform-users', scopeId: string, text: string) => {
      const encoded = encodeURIComponent(scopeId).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
      const directoryPath = join(storageRoot, owner, '.agent', 'im', 'qq', 'bot-1', branch, encoded)
      await mkdir(directoryPath, { recursive: true })
      await writeFile(join(directoryPath, 'profile.json'), JSON.stringify({ text }), 'utf8')
    }
    await writeScopeFile('groups', 'group-1', 'coffee current group')
    await writeScopeFile('groups', 'group-2', 'coffee other group')
    await writeScopeFile('platform-users', 'group-1:member-1', 'coffee current member')
    await writeScopeFile('platform-users', 'group-2:member-1', 'coffee other member')
    await writeScopeFile('platform-users', 'group-2:other-member', 'coffee other person')
    assert.equal(await createLocalAgentMemoryRagStore(storageRoot).readText({ ownerId: owner,
      key: `${owner}/.agent/im/qq/bot-1/groups/group-1/profile.json`, maxChars: 1000 }), JSON.stringify({ text: 'coffee current group' }))

    let imContext = { platform: 'qq', chatType: 'group', chatId: 'group-1', channelId: 'bot-1', role: 'member', platformUserId: 'member-1' }
    const pool = { async query(text: string, values: unknown[]) {
      assert.match(text, /s\.active_run_id\s*=\s*\$3/u)
      assert.deepEqual(values, [owner, '1', identity.runId])
      return { rows: [{ platform: imContext.platform, chat_type: imContext.chatType, chat_id: imContext.chatId,
        channel_id: imContext.channelId, owner_platform_user_id: 'owner-actor',
        platform_user_id: imContext.role === 'owner' ? 'owner-actor' : imContext.platformUserId, inbound_message_id: '601' }] }
    } } as unknown as Parameters<typeof createPostgresAgentImMemoryContextReader>[0]
    const context = createPostgresAgentImMemoryContextReader(pool)
    const scopesFor = createPostgresAgentMemoryScopeResolver(core.db, { context })
    const testSignal = new AbortController().signal
    const prepared = await prepareMemory({ ownerId: owner,
      scopes: await scopesFor(identity, 'current_group', testSignal), sourceFilter: 'all',
      snapshotRevision: 'scope-probe', snapshotText: '', vectorVersion: '' },
    { async getMemoryScopeState() { return { revision: 'test', tombstoned: false } } },
    createLocalAgentMemoryRagStore(storageRoot))
    assert.deepEqual(prepared.documents.map(document => [document.scope_type, document.scope_id, document.title]),
      [['group', 'group-1', '群组资料'], ['member', 'group-1:member-1', '群友资料']])
    const authorizedScopes: string[][] = []
    const registry = createAgentToolRegistry({ core, authorize: async (_current, name) => name === 'search_memory',
      memorySearch: createPostgresAgentMemorySearchPort(core, pool, {
        storageRoot,
        async authorize(_current, _signal, scopes) { authorizedScopes.push((scopes || []).map(scope => scope.id)); return true },
        async snapshot() { return { revision: 'scope-snapshot-v1', text: '' } },
      }),
    })
    const signal = new AbortController().signal
    const scope = { identity, roundId: 'round', signal, resolution: null, execute: async () => { throw new Error('unexpected') } }
    const dispatch = (id: string, requestedScope: string) => registry.tools.dispatch({ id, name: 'search_memory',
      input: { query: 'coffee', scope: requestedScope, owner_id: 'forged', group_id: 'forged' } }, scope)
    const results = async (requested: string) => {
      const result = await dispatch(`call-${requested}`, requested)
      assert.equal(result.kind === 'completed' && result.successful, true, JSON.stringify(result))
      const value = result.kind === 'completed' ? result.value as { results: Array<{ title: string; text: string }> } : { results: [] }
      assert.ok(value.results.length, JSON.stringify(value))
      return value.results
    }

    const currentMemberRows = await results('current_group')
    assert.deepEqual(currentMemberRows.map(row => row.title).sort(), ['群友资料', '群组资料'])
    assert.doesNotMatch(JSON.stringify(currentMemberRows), /other group|other member|other person/u)
    const memberCrossGroupRows = await results('all_my_groups')
    assert.deepEqual(memberCrossGroupRows.map(row => row.title).sort(), ['群友资料', '群友资料', '群组资料'])
    assert.match(JSON.stringify(memberCrossGroupRows), /coffee other member/u)
    assert.doesNotMatch(JSON.stringify(memberCrossGroupRows), /coffee other person/u)
    assert.deepEqual(authorizedScopes.at(-1)?.sort(), ['group-1', 'group-1:member-1', 'group-2:member-1'])

    imContext = { platform: 'qq', chatType: 'group', chatId: 'group-1', channelId: 'bot-1', role: 'owner', platformUserId: '' }
    const ownerCrossGroupRows = await results('all_my_groups')
    assert.deepEqual(ownerCrossGroupRows.map(row => row.title), ['群组资料', '群组资料'])
    assert.match(JSON.stringify(ownerCrossGroupRows), /coffee current group/u)
    assert.match(JSON.stringify(ownerCrossGroupRows), /coffee other group/u)
    assert.doesNotMatch(JSON.stringify(await results('current_group')), /coffee other group/u)
    const privateFromGroup = await dispatch('private-from-group', 'private_memory')
    assert.equal(privateFromGroup.kind === 'completed' && privateFromGroup.successful, false)
    if (privateFromGroup.kind === 'completed') {
      assert.equal((privateFromGroup.value as { error: string }).error, '当前会话不能读取 owner 私人记忆')
      assert.doesNotMatch(JSON.stringify(privateFromGroup.value), /coffee private memory/u)
    }
  } finally {
    await core.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('BYOK gate 在 query embedding 发起网络请求前再次校验', async () => {
  const owner = 'f17421a3-8520-4c8b-92e5-736882f4bd82'
  let enabled = true, requests = 0
  const pool = { async query() {
    return { rows: [{ provider: 'synthetic', base_url: 'https://embedding.example/v1', model: 'embed-v1', dimensions: 2,
      encrypted_value: 'cipher', nonce: 'nonce', encrypted_data_key: 'wrapped', key_version: 1 }] }
  } } as unknown as Parameters<typeof createPostgresAgentRagEmbeddingPort>[0]
  const embedding = createPostgresAgentRagEmbeddingPort(pool, {
    enabled: () => enabled,
    async decrypt() { return 'synthetic-secret' },
    createTransport: () => ({ async request() { requests++; throw new Error('不应调用外部服务') } }),
  })
  const settings = await embedding.resolve(owner)
  assert.ok(settings)
  enabled = false
  const transport = embedding.createTransport(settings)
  await assert.rejects(transport.request({ url: 'https://embedding.example/v1/embeddings', method: 'POST', headers: {}, body: {} }, new AbortController().signal), /BYOK embedding 当前不可用/u)
  assert.equal(requests, 0)
  await transport.close?.()
})

test('仅 Local/Ollama embedding 保留旧版本地 Provider 通道并继续传给安全 transport', async () => {
  const owner = 'f17421a3-8520-4c8b-92e5-736882f4bd82'
  let received: Record<string, unknown> | undefined
  const pool = { async query() {
    return { rows: [{ provider: ' Ollama ', base_url: 'http://127.0.0.1:11434/v1', model: 'local-embed', dimensions: 2,
      encrypted_value: 'cipher', nonce: 'nonce', encrypted_data_key: 'wrapped', key_version: 1 }] }
  } } as unknown as Parameters<typeof createPostgresAgentRagEmbeddingPort>[0]
  let configuredAllowLocal = false
  const embedding = createPostgresAgentRagEmbeddingPort(pool, {
    enabled: () => true,
    async decrypt() { return '' },
    createTransport(settings) {
      configuredAllowLocal = settings.allowLocal === true
      return { async request(request) {
        received = request as unknown as Record<string, unknown>
        return { status: 200, headers: {}, body: (async function* () {
          yield new TextEncoder().encode(JSON.stringify({ data: [{ embedding: [0.25, -0.5] }] }))
        })(), cancel: async () => {} }
      } }
    },
  })
  const settings = await embedding.resolve(owner)
  assert.equal(settings?.allowLocal, true)
  assert.equal(settings?.apiKey, '')

  const transport = embedding.createTransport(settings!)
  const result = await embedRagQuery(settings!, ' local query ', transport, new AbortController().signal)
  assert.equal(configuredAllowLocal, true)
  assert.deepEqual(result.vector, [0.25, -0.5])
  assert.equal(received?.allowLocal, true)
  assert.equal((received?.headers as Record<string, string>).authorization, undefined)
  await transport.close?.()
})
