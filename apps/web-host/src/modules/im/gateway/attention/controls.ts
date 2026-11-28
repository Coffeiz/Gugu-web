import { immediateImCommandReply, normalizeImWorkspaceArgument, parseImControlCommand, parseImWorkspaceDeletion, runImAutomaticModeCommand, runImForgetCommand } from '@gugu/core/im/shortcut'
import { CoreError, createWorkspaceDeleter } from '@gugu/core'
import { applyAgentGoalCommand, projectAgentSessionGoal, readAgentSessionContext, resetPostgresImSessionLocked } from '@gugu/core/agent-sessions'
import { AgentFilesystemAuthorizationError, readActiveSessionFilesystemGrant, type createAgentSessionFilesystemAuthorization } from '../../../agent/sandbox/authorization.js'
import { createPostgresWorkspaceDeletionTransaction } from '../../../workspaces/store.js'
import { createPostgresWorkspaceBindingOperations } from '../../../workspaces/bindings.js'
import { isAgentCommandHelpArgument } from '@gugu/core/agent/commands/help'
import { canonicalAgentCommandName, parseAgentGoalArgument, workspaceOptionsReply } from '@gugu/core/agent/commands/menu'
import { imSessionScopeSql } from '../agent/conversations.js'
import { createHash, createHmac } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { stableJson, type CanonicalRunContext, type CancellationPort } from '@gugu/core/agent'
import { resolveImAccess, type ImActorInput } from '@gugu/core/im/access'
import { imCanUseTool } from '@gugu/core/agent/scenes/im'
import { replyToImMemoryCommand, createImInboundPreflight, type ImPreflightPorts, type ImPreflightScope } from '@gugu/gateway'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import { createAgentInteractionRespondService } from '../../../agent/interactions/respond.js'
import { createPostgresAgentRunStore } from '../../../agent/run/store.js'
import { createPostgresImSecretInput, type ImSecretInputPorts } from '../../../agent/interactions/im-secret.js'
import { agentDispatchSource, decryptAgentDispatchInput, type ImAgentDispatchInput } from '../../../agent/run/dispatch.js'
import { createInteractionResumeEnqueuer } from '../../../agent/interactions/resume.js'
import type { InteractionSideEffects } from '../../../agent/interactions/consume.js'
import { imInteractionScopeSql, imInteractionScopeParameters } from '../../../agent/interactions/replay.js'
import { createPostgresImAccess } from '../inbound/access.js'
import { createPostgresRedisBindingConsumer } from '../inbound/binding.js'
import { imActorInputForDispatch, type ImAgentReconstructorOptions } from '../agent/reconstruct.js'
import { createPostgresImTextChoiceConsumer, type ImInteractionTarget } from '../interactions/lookup.js'
import { createPostgresImShortcut } from './receipts.js'
import { createImShortcutControls } from './shortcuts.js'
import type { RedisCommandClient } from '../../../../workers/redis-stream-queue.js'

export type ImControlDiagnostic = 'binding_post_commit_pending' | 'secret_wake_pending' | 'interaction_wake_pending'
  | 'shortcut_notification_pending' | 'shortcut_read_unavailable' | 'compact_unavailable'
export class ImControlsUnavailable extends Error {
  constructor() { super('IM 控制服务暂不可用'); this.name = 'ImControlsUnavailable' }
}
const fail = () => new ImControlsUnavailable()
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
interface Proof { input: ImActorInput; dispatchHash: string; messagesHash: string }

/** 组合既有真实持久服务；平台发送、业务加密/确认及提交后唤醒均须由Host提供。 */
export function createPostgresImControls(options: {
  pool: Pick<Pool,'connect'|'query'>; redis: RedisCommandClient; secretKey: string
  supportedPlatforms(): readonly string[] | Promise<readonly string[]>
  readRoute: ImAgentReconstructorOptions['readRoute']
  history: Parameters<typeof createPostgresAgentRunStore<CanonicalRunContext>>[2]
  crypto: Pick<ImSecretInputPorts,'encrypt'|'decrypt'>
  invalidateMcpLocked: ImSecretInputPorts['invalidate']
  interactionEffects: Pick<InteractionSideEffects,'applyCommandAction'|'redeemConfirmation'>
  cancellation: Pick<CancellationPort,'request'|'notify'>
  wakeInteractions(): Promise<void>; wakeDispatch(): void | Promise<void>
  invalidateBinding(scope: ImPreflightScope): void; publishBindingChanged(ownerId: string): Promise<void>
  reply(scope: ImPreflightScope, text: string, options: Parameters<ImPreflightPorts['reply']>[2] & { ownerOnly?: boolean }): Promise<void>
  diagnose(code: ImControlDiagnostic): void
  filesystemAuthorization?: ReturnType<typeof createAgentSessionFilesystemAuthorization>
  resetContext?: {
    readOwnerSession(client: PoolClient, scope: ImPreflightScope): Promise<number | null>
    removeAttachment(ownerId: string, storageKey: string): Promise<unknown>
  }
  automaticModeEnabled?: boolean
  forgetMemory?(scope: ImPreflightScope, query: string, signal: AbortSignal): Promise<number>
  readMemory?(ownerId: string, signal: AbortSignal): Promise<string>
  compact?: Parameters<typeof createImShortcutControls>[0]['compact']
}) {
  if(typeof options.secretKey!=='string'||!options.secretKey)throw fail()
  for (const fn of [options.pool?.connect,options.pool?.query,options.redis?.sendCommand,options.readRoute,options.history?.writeHistory,options.crypto?.encrypt,options.crypto?.decrypt,options.invalidateMcpLocked,
    options.interactionEffects?.applyCommandAction,options.interactionEffects?.redeemConfirmation,options.cancellation?.request,options.cancellation?.notify,
    options.wakeInteractions,options.wakeDispatch,options.invalidateBinding,options.publishBindingChanged,options.reply,options.diagnose,options.supportedPlatforms]) {
    if(typeof fn!=='function')throw fail()
  }
  const report=(code:ImControlDiagnostic)=>{try{options.diagnose(code)}catch{/* 固定诊断失败不改变持久消费事实。 */}}
  const access=createPostgresImAccess({query:(q,p)=>options.pool.query(q,p),supportedPlatforms:options.supportedPlatforms})
  const store=createPostgresAgentRunStore<CanonicalRunContext>(options.pool,options.secretKey,options.history)
  const enqueue=createInteractionResumeEnqueuer(store)
  const binding=createPostgresRedisBindingConsumer({pool:options.pool,redis:options.redis,secretKey:options.secretKey,
    invalidate:options.invalidateBinding,publishChanged:options.publishBindingChanged,report(){report('binding_post_commit_pending')}})
  const commandNames = ['stop', 'status', 'goal', ...(options.resetContext ? ['new'] : []), ...(options.compact ? ['compact'] : []), ...(options.readMemory ? ['memory'] : []), ...(options.forgetMemory ? ['forget'] : []), 'workspace', ...(options.automaticModeEnabled === undefined ? [] : ['auto']), 'help']
  const shortcut=createImShortcutControls({state:createPostgresImShortcut({...options,diagnose:report,wake:options.wakeDispatch}),diagnose:report,compact:options.compact,helpCommands:commandNames})
  const workspaces = createPostgresWorkspaceBindingOperations(options.pool)
  async function decideShortcut(scope: ImPreflightScope, text: string, signal: AbortSignal) {
    const command = parseImControlCommand(text)
    const immediate = immediateImCommandReply(text, commandNames)
    if (immediate) {
      const workspaceHelp = command?.name === 'workspace' && isAgentCommandHelpArgument(command.argument)
        || command?.name === 'help' && canonicalAgentCommandName(command.argument) === 'workspace'
      return { action: 'reply' as const, reply: workspaceHelp && options.filesystemAuthorization
        ? `${immediate} 使用 /workspace status 查看权限，/workspace god 申请，/workspace revoke 撤销。` : immediate }
    }
    if (command?.name === 'goal') {
      const action = parseAgentGoalArgument(command.argument)
      const update = await withPostgresTransaction(options.pool, async client => {
        signal.throwIfAborted()
        await client.query(`SELECT b.id FROM user_bots b JOIN users u ON u.id=b.user_id
          WHERE b.user_id=$1 AND b.id=$2 AND b.platform=$3 FOR SHARE OF b,u`, [scope.ownerId, scope.botId, scope.platform])
        const bot = await scopedAccess(client).readBot(scope)
        if (!bot || resolveImAccess(scope, bot).role !== 'owner') return { reply: '只有绑定 Bot 的用户可以管理目标任务。' }
        if (!action) return { reply: '用法：/goal <目标>、/goal status、/goal pause、/goal resume、/goal cancel。' }
        if (action === 'create') return null
        const bound = await options.resetContext?.readOwnerSession(client, scope)
        const fields = 'id,session_context,active_run_id'
        type Session = { id: number; session_context: unknown; active_run_id: string | null }
        const { rows: [session] } = bound
          ? await client.query<Session>(`SELECT ${fields} FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE`, [scope.ownerId, bound])
          : await client.query<Session>(`SELECT ${fields} FROM conversation_sessions WHERE ${imSessionScopeSql} ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE`,
            [scope.ownerId, scope.platform, scope.botId, scope.chatId, scope.platformUserId])
        if (!session) return { reply: '当前会话没有进行中的目标任务。' }
        const context = readAgentSessionContext(session.session_context, 'postgres')
        const interrupt = (action === 'pause' || action === 'cancel') && projectAgentSessionGoal(context).goalActive ? session.active_run_id : null
        const result = applyAgentGoalCommand(context, action)
        if (result.changed) await client.query('UPDATE conversation_sessions SET session_context=$3::jsonb WHERE user_id=$1 AND id=$2',
          [scope.ownerId, session.id, JSON.stringify(context)])
        return { reply: result.text, interrupt: interrupt ? { ownerId: scope.ownerId, sessionId: String(session.id), runId: interrupt } : null }
      }, fail)
      if (!update) return { action: 'run' as const }
      if (update.interrupt) {
        await options.cancellation.request(update.interrupt)
        await options.cancellation.notify(update.interrupt)
      }
      return { action: 'reply' as const, reply: update.reply }
    }
    const reset = options.resetContext
    if (command?.name === 'new' && reset) {
      const result = await withPostgresTransaction(options.pool, async client => {
        signal.throwIfAborted()
        await client.query(`SELECT b.id FROM user_bots b JOIN users u ON u.id=b.user_id
          WHERE b.user_id=$1 AND b.id=$2 AND b.platform=$3 FOR SHARE OF b,u`, [scope.ownerId, scope.botId, scope.platform])
        const bot = await scopedAccess(client).readBot(scope)
        if (!bot || resolveImAccess(scope, bot).role !== 'owner') return { reply: '只有绑定 Bot 的用户可以开启新对话。' }
        const bound = await reset.readOwnerSession(client, scope)
        const session = bound ?? (await client.query<{ id: number }>(
          `SELECT id FROM conversation_sessions WHERE ${imSessionScopeSql} ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE`,
          [scope.ownerId, scope.platform, scope.botId, scope.chatId, scope.platformUserId])).rows[0]?.id
        if (!session) return { reply: '当前还没有可重置的对话。' }
        const keys = await resetPostgresImSessionLocked(client, scope.ownerId, session)
        return keys === null ? { reply: '请先等待当前任务结束或停止任务。' }
          : { reply: '已开启新对话，旧的对话上下文已清空。', keys }
      }, fail)
      for (const key of result.keys ?? []) {
        try { await reset.removeAttachment(scope.ownerId, key) } catch { report('shortcut_notification_pending') }
      }
      return { action: 'reply' as const, reply: result.reply }
    }
    if (command?.name === 'auto' && options.automaticModeEnabled !== undefined) {
      const bot = await access.readBot(scope)
      if (!bot) throw fail()
      const reply = await runImAutomaticModeCommand(command.argument, {
        owner: resolveImAccess(scope, bot).role === 'owner', enabled: options.automaticModeEnabled,
        async read() {
          const { rows: [row] } = await options.pool.query<{ enabled: boolean }>(`
            SELECT COALESCE(data_json::jsonb->'automatic_mode_enabled' = 'true'::jsonb, false) AS enabled
            FROM user_preferences WHERE user_id=$1`, [scope.ownerId])
          return row?.enabled === true
        },
        async write(enabled) {
          await options.pool.query(`INSERT INTO user_preferences (user_id,data_json,updated_at)
            VALUES ($1,jsonb_build_object('automatic_mode_enabled',$2::boolean)::text,CURRENT_TIMESTAMP)
            ON CONFLICT (user_id) DO UPDATE SET data_json=jsonb_set(
              user_preferences.data_json::jsonb - 'automaticModeEnabled','{automatic_mode_enabled}',to_jsonb($2::boolean))::text,
              updated_at=CURRENT_TIMESTAMP`, [scope.ownerId, enabled])
          return enabled
        },
      })
      return { action: 'reply' as const, reply }
    }
    const forget = options.forgetMemory
    if (command?.name === 'forget' && forget) {
      const bot = await access.readBot(scope)
      const reply = await runImForgetCommand(command.argument, !!bot && resolveImAccess(scope, bot).role === 'owner',
        query => forget(scope, query, signal))
      return { action: 'reply' as const, reply }
    }
    const readMemory = options.readMemory
    if (command?.name === 'memory' && readMemory) {
      const target = { ...scope, chatType: 'c2c' as const, chatId: null }
      const reply = await replyToImMemoryCommand({
        chatType: scope.chatType, signal,
        async authorizeOwner() {
          if (scope.chatType === 'c2c') return privateOwner(scope, signal)
          const bot = await access.readBot(scope)
          return !!bot && resolveImAccess(scope, bot).role === 'owner'
        },
        readMemory: () => readMemory(scope.ownerId, signal),
        async sendOwnerPrivate(memory) {
          if (!await privateOwner(target, signal)) return false
          await options.reply(target, memory, { quote: false, signal, ownerOnly: true })
          return true
        },
      })
      return { action: 'reply' as const, reply }
    }
    if (command?.name !== 'workspace') return shortcut.decideShortcut(scope, text, signal)
    const reply = (value: string) => ({ action: 'reply' as const, reply: value })
    if (scope.chatType !== 'c2c') return reply('请在私聊中查看或绑定工作区。')
    if (!await privateOwner(scope, signal)) return reply('只有绑定 Bot 的用户可以管理工作区。')
    const argument = normalizeImWorkspaceArgument(command.argument)
    const deletion = parseImWorkspaceDeletion(argument)
    if (deletion) {
      if (deletion.kind === 'usage') return reply('用法：/workspace delete <ID> [confirm]')
      return withPostgresTransaction(options.pool, async client => {
        await client.query(`SELECT b.id FROM user_bots b JOIN users u ON u.id=b.user_id
          WHERE b.user_id=$1 AND b.id=$2 AND b.platform=$3 FOR SHARE OF b,u`, [scope.ownerId, scope.botId, scope.platform])
        const bot = await scopedAccess(client).readBot(scope)
        if (!bot || resolveImAccess(scope, bot).role !== 'owner') return reply('只有绑定 Bot 的用户可以删除工作区。')
        const { rows: [target] } = await client.query<{ name: string }>(
          'SELECT name FROM workspaces WHERE user_id=$1 AND id=$2 FOR UPDATE', [scope.ownerId, deletion.id])
        if (!target) return reply('工作区不存在。')
        if (deletion.kind === 'prompt')
          return reply(`删除「${target.name}」会解除会话绑定，项目和文件会保留。确认请发送 /workspace delete ${deletion.id} confirm。`)
        const remove = createWorkspaceDeleter({ transaction: work => work(createPostgresWorkspaceDeletionTransaction(client)) })
        await remove(scope.ownerId, deletion.id, { signal })
        return reply(`已删除工作区「${target.name}」。`)
      })
    }
    if (argument === 'list') {
      const { rows } = await options.pool.query<{ id: number; name: string }>(
        'SELECT id,name FROM workspaces WHERE user_id=$1 AND enabled IS TRUE ORDER BY id', [scope.ownerId])
      return reply(workspaceOptionsReply(rows))
    }
    const authorization = /^(status|revoke|god)(?:\s+([a-zA-Z0-9_-]+))?$/u.exec(argument)
    const number = /^(?:bind\s+)?([1-9][0-9]*)$/u.exec(argument)
    if (!authorization && argument !== 'show' && argument !== 'unlink' && (!number || !Number.isSafeInteger(Number(number[1]))))
      return reply('请使用 /workspace list、show、<ID> 或 unlink。')
    const sessionId = await withPostgresTransaction(options.pool, async client => {
      const selected = await options.resetContext?.readOwnerSession(client, scope)
      if (selected !== undefined && selected !== null) return selected
      const { rows: [session] } = await client.query<{ id: number }>(
        `SELECT id FROM conversation_sessions WHERE ${imSessionScopeSql} ORDER BY updated_at DESC,id DESC LIMIT 1`,
        [scope.ownerId, scope.platform, scope.botId, scope.chatId, scope.platformUserId])
      return session?.id
    }, fail)
    if (!sessionId) return reply(argument === 'show' ? '当前会话的工作区：个人文件。' : '当前还没有会话，请先发送一条普通消息。')
    try {
      if (authorization) {
        const [, action, code] = authorization
        if (code && action !== 'god') return reply('用法：/workspace status、/workspace god 或 /workspace revoke。')
        const api = options.filesystemAuthorization
        if (action === 'status') {
          if (!api?.enabled()) return reply('完整用户沙箱授权功能当前未开启。')
          const active = await readActiveSessionFilesystemGrant(options.pool, scope.ownerId, sessionId, new Date())
          return reply(active ? '当前会话已获得完整用户沙箱读写权限。可用 /workspace revoke 撤销。' : '当前会话没有完整用户沙箱授权。')
        }
        if (!api) return reply('当前入口未接入完整用户沙箱授权。')
        if (action === 'revoke') {
          const state = await api.revoke(scope.ownerId, sessionId) as { revoked: boolean }
          return reply(state.revoked ? '已撤销当前会话的完整用户沙箱权限。' : '当前会话没有生效中的完整用户沙箱授权。')
        }
        if (code) {
          await api.confirm(scope.ownerId, sessionId, code)
          return reply('已授权当前会话读写完整用户沙箱。')
        }
        const state = await api.request(scope.ownerId, sessionId) as { status: string; confirm_code?: string }
        return reply(state.status === 'authorized' ? '当前会话已获得完整用户沙箱读写权限。'
          : `确认后本会话可读写完整用户沙箱。请在十分钟内发送 /workspace god ${state.confirm_code}。`)
      }
      if (argument === 'show') {
        const current = await workspaces.current(scope.ownerId, sessionId, { signal })
        return reply(current ? `当前会话绑定的工作区：${current.name}（${current.id}）` : '当前会话的工作区：个人文件。')
      }
      if (argument === 'unlink') {
        await workspaces.unbind(scope.ownerId, sessionId, { signal })
        return reply('已将当前会话切回个人文件。')
      }
      const bound = await workspaces.bind(scope.ownerId, Number(number![1]), sessionId, { signal })
      return reply(`已将当前会话绑定到工作区「${bound.name}」。`)
    } catch (error) {
      if (error instanceof CoreError || error instanceof AgentFilesystemAuthorizationError) return reply(error.message)
      throw error
    }
  }
  const scopedAccess=(client:PoolClient)=>createPostgresImAccess({query:(q,p)=>client.query(q,p),supportedPlatforms:options.supportedPlatforms})
  async function authorize(scope:ImPreflightScope,signal:AbortSignal) {
    signal.throwIfAborted()
    if(!scope.admissionCutoff)throw fail()
    return await access.readBot(scope)!==null
  }
  async function privateOwner(scope:ImPreflightScope,signal:AbortSignal) {
    signal.throwIfAborted()
    const bot=await access.readBot(scope)
    return scope.chatType==='c2c' && bot!==null && resolveImAccess(scope,bot).role==='owner'
  }
  async function material(client:PoolClient,scope:ImPreflightScope,target:ImInteractionTarget) {
    if(target.identity.ownerId!==scope.ownerId)throw fail()
    const row=(await client.query(`SELECT d.nonce,d.payload,a.created_at<=$4::timestamptz AS admitted
      FROM agent_run_dispatch d JOIN agent_run_startups a ON a.user_id=d.user_id AND a.session_id=d.session_id AND a.run_id=d.run_id
      WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3 AND d.cancel_requested IS FALSE AND a.status<>'failed'`,
    [scope.ownerId,target.identity.sessionId,target.identity.runId,scope.admissionCutoff])).rows[0]
    if(!row||row.admitted!==true)throw fail()
    const input=decryptAgentDispatchInput(options.secretKey,target.identity,row.nonce,row.payload)
    if(agentDispatchSource(input)!=='im'||input.v!==3||input.source!=='im')throw fail()
    const im=input.im
    if(im.platform!==scope.platform||im.botId!==scope.botId||im.chatType!==scope.chatType||im.chatId!==scope.chatId
      ||scope.chatType==='c2c'&&im.platformUserId!==scope.platformUserId)throw fail()
    const ids=im.batch?.messageIds??[input.userMessageId]
    const messages=(await client.query(`SELECT m.id,m.platform_user_id,m.chat_type,m.created_at<=$4::timestamptz AS admitted,
        r.platform,r.bot_id,r.chat_type AS receipt_chat_type,r.state,r.scope_hash,r.event_hash,r.sealed_payload
      FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=$1
      LEFT JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=m.session_id AND r.message_id=m.id AND r.run_id=m.run_id
      WHERE m.session_id=$2 AND m.run_id=$3 AND m.role='user' ORDER BY m.id`,
    [scope.ownerId,target.identity.sessionId,target.identity.runId,scope.admissionCutoff])).rows
    const scopeHash=createHmac('sha256',options.secretKey).update('gugu-im-conversation-v1\0').update(stableJson([scope.ownerId,scope.platform,scope.botId,scope.chatType,scope.chatId??scope.platformUserId])).digest('hex')
    if(messages.length!==ids.length||new Set(messages.map(m=>m.id)).size!==ids.length||!messages.some(m=>m.platform_user_id===scope.platformUserId)
      ||messages.some(m=>!ids.includes(Number(m.id))||m.admitted!==true||m.platform!==scope.platform||m.bot_id!==scope.botId
        ||m.chat_type!==scope.chatType||m.receipt_chat_type!==scope.chatType||m.scope_hash!==scopeHash||m.state!=='dispatched'
        ||scope.chatType==='c2c'&&m.platform_user_id!==scope.platformUserId))throw fail()
    return{input:input as ImAgentDispatchInput,dispatchHash:digest([row.nonce.toString('base64'),row.payload.toString('base64')]),messagesHash:digest(messages)}
  }
  async function prepareProof(scope:ImPreflightScope,target:ImInteractionTarget):Promise<Proof> {
    const route=await options.readRoute(target.identity)
    if(!route)throw fail()
    return withPostgresTransaction(options.pool,async client=>{
      const m=await material(client,scope,target)
      return{input:imActorInputForDispatch({identity:target.identity,input:m.input},route),dispatchHash:m.dispatchHash,messagesHash:m.messagesHash}
    },fail)
  }
  async function verify(client:PoolClient,scope:ImPreflightScope,target:ImInteractionTarget,proof:Proof,signal:AbortSignal) {
    signal.throwIfAborted()
    // 消费事务内复查并锁住当前权限；不把lookup的快照当作执行授权。
    await client.query(`SELECT bot.id FROM user_bots bot JOIN users u ON u.id=bot.user_id WHERE bot.id=$1 AND bot.user_id=$2 AND bot.platform=$3 FOR SHARE OF bot,u`,[scope.botId,scope.ownerId,scope.platform])
    const current=await material(client,scope,target)
    if(current.dispatchHash!==proof.dispatchHash||current.messagesHash!==proof.messagesHash)throw fail()
    const bound=(await client.query(`SELECT b.interaction_id,b.tool_call_id,p.kind,p.schema_json FROM agent_interaction_bindings b
      JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
      WHERE b.user_id=$1 AND b.session_id=$2 AND b.run_id=$3 AND b.prompt_id=$4
        AND p.schema_json::jsonb->>'source'='agent' AND p.schema_json::jsonb->'context'->>'tool_call_id'=b.tool_call_id`,
    [scope.ownerId,target.identity.sessionId,target.identity.runId,target.promptId])).rows[0]
    const checkpoint=await store.readForUpdate(client,target.identity),pending=checkpoint?.pending
    if(!bound||checkpoint?.status!=='waiting'||!pending||pending.id!==bound.interaction_id||pending.toolCall.id!==bound.tool_call_id||bound.tool_call_id!==target.toolCallId)throw fail()
    const schema=bound.schema_json as Record<string,unknown>,context=schema.context as Record<string,unknown>
    if(context.tool_name!==pending.toolCall.name
      ||(pending.kind==='credential')!==(Array.isArray(schema.secret_fields)&&schema.secret_fields.length>0)
      ||(pending.kind==='confirmation')!==(bound.kind==='confirm')
      ||pending.kind==='question'&&!['question','choice'].includes(bound.kind))throw fail()
    const snapshot=await scopedAccess(client).snapshot(proof.input),actor=snapshot.actor(proof.input)
    if(actor.role==='unknown'||scope.chatType==='c2c'&&actor.role!=='owner'||!imCanUseTool(actor,pending.toolCall.name))throw fail()
    signal.throwIfAborted()
  }
  function perScope(scope:ImPreflightScope,signal:AbortSignal) {
    const proofs=new Map<number,{target:ImInteractionTarget;proof:Proof}>()
    const authorizeTarget=async(target?:ImInteractionTarget)=>{
      if(!await authorize(scope,signal))return false
      if(!target)return scope.chatType==='group'||await privateOwner(scope,signal)
      const proof=await prepareProof(scope,target)
      await withPostgresTransaction(options.pool,client=>verify(client,scope,target,proof,signal),fail)
      proofs.set(target.promptId,{target,proof});return true
    }
    const enqueueChecked:ImSecretInputPorts['enqueue']=async(client,prompt,action)=>{
      const found=proofs.get(prompt.id)
      if(!found||prompt.ownerId!==scope.ownerId||String(prompt.sessionId)!==found.target.identity.sessionId)throw fail()
      await verify(client,scope,found.target,found.proof,signal)
      await enqueue(client,prompt,action)
    }
    const secret=createPostgresImSecretInput(options.pool,{...options.crypto,enqueue:enqueueChecked,invalidate:options.invalidateMcpLocked,
      async authorizeLocked(client,current,target){
        const found=proofs.get(target.promptId)
        if(!found||current.ownerId!==scope.ownerId||target.identity.ownerId!==scope.ownerId||target.identity.runId!==found.target.identity.runId
          ||target.identity.sessionId!==found.target.identity.sessionId||target.toolCallId!==found.target.toolCallId)throw fail()
        await verify(client,scope,found.target,found.proof,signal)
      },
      wake:options.wakeInteractions,diagnose(){report('secret_wake_pending')}})
    return{authorizeTarget,secret,enqueueChecked,async prepareSecrets(){
      const rows=await options.pool.query(`SELECT DISTINCT p.id,p.session_id,b.run_id,b.tool_call_id ${imInteractionScopeSql}
        AND EXISTS(SELECT 1 FROM mcp_secret_inputs stage WHERE stage.prompt_id=p.id AND stage.user_id=p.user_id AND stage.status IN ('pending_choice','awaiting_secret'))`,imInteractionScopeParameters(scope))
      if(rows.rows.length>32)throw fail()
      for(const row of rows.rows)await authorizeTarget({identity:{ownerId:scope.ownerId,sessionId:String(row.session_id),runId:row.run_id},promptId:row.id,toolCallId:row.tool_call_id})
    }}
  }
  const ports:ImPreflightPorts={
    authorize,
    async inspectSecret(scope,signal){
      const stage=await perScope(scope,signal).secret.inspectSecret(scope,signal)
      // 解绑不能让仍在等待的秘密字段落入普通历史；旧stage继续消费为失效提示。
      if((stage.status==='pending_choice'||stage.status==='awaiting_secret')&&!await privateOwner(scope,signal))return{status:'ended'}
      return stage
    },
    async applySecret(scope,reference,action,signal){
      if(!await privateOwner(scope,signal))throw fail()
      const bound=perScope(scope,signal);await bound.prepareSecrets()
      return bound.secret.applySecret(scope,reference,action,signal)
    },
    bindQqOwnerIfUnbound:binding.bindQqOwnerIfUnbound,consumeBinding:binding.consumeBinding,
    async consumeTextChoice(scope,text,signal){
      if(scope.chatType==='c2c'&&!await privateOwner(scope,signal))return null
      const bound=perScope(scope,signal)
      const service=createAgentInteractionRespondService({pool:options.pool,effects:options.interactionEffects,enqueue:bound.enqueueChecked,
        wake:options.wakeInteractions,diagnose(){report('interaction_wake_pending')}})
      return createPostgresImTextChoiceConsumer({pool:options.pool,service,secretKey:options.secretKey,authorize:(_scope,_signal,target)=>bound.authorizeTarget(target)})(scope,text,signal)
    },
    ...shortcut,decideShortcut,reply:options.reply,
  }
  /** 原生按钮只消费给定token，不轮换token或按label/序号重新选择。 */
  async function consumeNativeAction(scope:ImPreflightScope,promptId:number,token:string,signal:AbortSignal,replayOnly=false):Promise<{accepted:boolean;replayed:boolean;awaitingText?:boolean; nextQuestion?: { index: number; text: string }}> {
    if(!Number.isSafeInteger(promptId)||promptId<1||typeof token!=='string'||!token||token.length>256||!await authorize(scope,signal))return{accepted:false,replayed:false}
    const bot=await access.readBot(scope)
    if(!bot||scope.platform==='telegram'&&resolveImAccess(scope,bot).role!=='owner'||scope.chatType==='c2c'&&!await privateOwner(scope,signal))return{accepted:false,replayed:false}
    const rows=(await options.pool.query(`SELECT DISTINCT p.id,p.session_id,p.schema_json,b.run_id,b.tool_call_id,
        p.created_at<=$9::timestamptz AS admitted
      ${imInteractionScopeSql} AND p.id=$7
      AND EXISTS(SELECT 1 FROM interaction_actions token_action WHERE token_action.prompt_id=p.id AND token_action.token_hash=$8)`,
    [...imInteractionScopeParameters(scope),promptId,createHash('sha256').update(token).digest('hex'),scope.admissionCutoff]).catch(()=>{throw fail()})).rows
    // action单独查询，不能让其他option的消费事实替代给定token。
    const row=rows[0]
    if(!row||rows.some(r=>r.run_id!==row.run_id||r.session_id!==row.session_id))return{accepted:false,replayed:false}
    const action=(await options.pool.query(`SELECT option_id,status,consumed_event_id,expires_at>clock_timestamp() AS live FROM interaction_actions WHERE prompt_id=$1 AND token_hash=$2`,[promptId,createHash('sha256').update(token).digest('hex')])).rows[0]
    if(!action||row.admitted!==true)return{accepted:false,replayed:false}
    if(action.status==='consumed'&&action.consumed_event_id===scope.eventId){
      const schema=row.schema_json as Record<string,unknown>,result=schema.resolved_result as Record<string,unknown>|undefined
      return{accepted:result?.status!=='error',replayed:true,awaitingText:action.option_id==='__custom_reply__'&&schema.custom_input_active===true}
    }
    if(replayOnly||action.status!=='pending'||!action.live)return{accepted:false,replayed:false}
    const bound=perScope(scope,signal),target={identity:{ownerId:scope.ownerId,sessionId:String(row.session_id),runId:row.run_id},promptId,toolCallId:row.tool_call_id}
    if(!await bound.authorizeTarget(target))return{accepted:false,replayed:false}
    const schema=row.schema_json as Record<string,unknown>
    if(Array.isArray(schema.secret_fields)&&schema.secret_fields.length){
      if(scope.chatType!=='c2c'||!['input_credentials','cancel'].includes(action.option_id))return{accepted:false,replayed:false}
      const stage=await bound.secret.inspectSecret(scope,signal)
      if(!('reference' in stage))return{accepted:stage.status==='replay',replayed:stage.status==='replay'}
      const result=await bound.secret.applyNativeSecret(scope,stage.reference,{action:action.option_id==='cancel'?'cancel':'start'},{promptId,token},signal)
      if(result.status==='awaiting_secret'||result.status==='cancelled')await options.reply(scope,result.status==='cancelled'?'已取消凭据输入。':`请发送「${result.fieldLabel||'凭据'}」的值。取消输入请发送“取消”。`,{quote:false,signal})
      return{accepted:result.status!=='failed',replayed:result.status==='replay'}
    }
    const service=createAgentInteractionRespondService({pool:options.pool,effects:options.interactionEffects,enqueue:bound.enqueueChecked,wake:options.wakeInteractions,diagnose(){report('interaction_wake_pending')}})
    const result=await service.respond(scope.ownerId,promptId,token,scope.eventId)
    if(result.prompt_id!==promptId||String(result.session_id)!==target.identity.sessionId)throw fail()
    if (result.result.status === 'question_next' && typeof result.result.question_index === 'number'
      && typeof result.result.text === 'string')
      return { accepted: true, replayed: false, nextQuestion: { index: result.result.question_index, text: result.result.text } }
    const awaitingText = result.result.status === 'awaiting_text'
    if ((scope.platform === 'qq' || scope.platform === 'telegram') && awaitingText) {
      try { await options.reply(scope, '请直接发送你的回复，咕咕会继续处理。', { quote: false, signal }) }
      catch { report('interaction_wake_pending') }
    }
    return{accepted:result.result.status!=='error',replayed:false,awaitingText}
  }
  return{ports,preflight:createImInboundPreflight(ports),consumeNativeAction,
    replyQuestion: (scope: ImPreflightScope, text: string, signal: AbortSignal) => options.reply(scope, text, { quote: false, signal }),
    authorizeNativeTarget:(scope:ImPreflightScope,target:ImInteractionTarget,signal:AbortSignal)=>perScope(scope,signal).authorizeTarget(target)}
}
