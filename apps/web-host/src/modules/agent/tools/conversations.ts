import type { Pool } from 'pg'
import type { ConversationReadPort,ConversationSearchPort } from '@gugu/core/tools'
import type { RunIdentity } from '@gugu/core/agent'
import { createPostgresAgentConversationTextReader } from '@gugu/core/agent-sessions'

/** 复用会话历史读取服务；owner 仅来自可信运行身份。 */
export function createAgentConversationReadPort(pool:Pick<Pool,'query'|'connect'>):ConversationReadPort {
 const read=createPostgresAgentConversationTextReader(pool)
 return {read:(identity,sessionId,limit,signal)=>read(identity.ownerId,sessionId,limit,signal)}
}

export { createAgentConversationSearchPort, createCoreAgentConversationSearchPort } from '@gugu/core/agent-sessions'

/** 将生产 Web RAG 会话搜索限制在 dispatch lease 的 owner 范围。 */
export function bindAgentConversationSearchOwner(port: ConversationSearchPort, ownerId: string): ConversationSearchPort {
 if(typeof ownerId!=='string'||!ownerId.trim())throw new TypeError('Agent RAG owner 身份无效')
 const expectedOwner=ownerId.toLowerCase()
 const assertOwner=(identity:RunIdentity,signal:AbortSignal)=>{
  signal.throwIfAborted()
  if(typeof identity?.ownerId!=='string'||identity.ownerId.toLowerCase()!==expectedOwner)throw new Error('Agent RAG 运行身份不匹配')
 }
 return {
  async recent(identity,limit,signal){assertOwner(identity,signal);return port.recent(identity,limit,signal)},
  async search(identity,queries,mode,limit,signal){assertOwner(identity,signal);return port.search(identity,queries,mode,limit,signal)},
  async resolve(identity,hit,signal){assertOwner(identity,signal);return port.resolve(identity,hit,signal)},
 }
}
