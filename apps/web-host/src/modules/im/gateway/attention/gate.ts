import { stableJson, type AgentRunnerPorts, type CanonicalRunContext, type RunIdentity } from '@gugu/core/agent'
import type { ImActorInput } from '@gugu/core/im/access'
import { createChooseNoReplyTool } from '@gugu/core/tools'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** 与正式准备能力及实时授权共同判定；工具名或模型参数本身不赋予静默权限。 */
export function createImGroupReplyGate(options: { identity: RunIdentity; input: ImActorInput;
  authorizeTool(input: ImActorInput, name: string, groupAutoReply: boolean): Promise<boolean> }) {
  const identity = { ...options.identity }, input = structuredClone(options.input), decline = createChooseNoReplyTool()
  if (input.ownerId !== identity.ownerId || input.chatType !== 'group' || input.platform === 'wechat') throw new Error('IM 群回复门作用域无效')
  const classifyCall: NonNullable<AgentRunnerPorts<CanonicalRunContext>['replyGate']>['classifyCall'] = async (context, call) => {
    if (context.identity.ownerId !== identity.ownerId || context.identity.sessionId !== identity.sessionId || context.identity.runId !== identity.runId
      || call.parseError || !context.capabilities?.toolNames.includes(call.name)) return 'invalid'
    const tools = context.capabilities.tools.filter(tool => tool.name === call.name)
    if (tools.length !== 1 || !object(tools[0]!.schema) || tools[0]!.schema.type !== 'function'
      || !object(tools[0]!.schema.function) || tools[0]!.schema.function.name !== call.name
      || call.name === 'choose_no_reply' && stableJson(tools[0]!.schema) !== stableJson(decline.definition.schema)
      || !await options.authorizeTool(input, call.name, true)) return 'invalid'
    if (call.name !== 'choose_no_reply') return 'business'
    return decline.validate(call.input).success ? 'decline' : 'invalid'
  }
  return { definition: decline.definition, classifyCall }
}
