
import type { HarnessExecutorPorts } from './executor/contracts.js'
import { createHarnessExecutor } from './executor/executor.js'
import { createCanonicalContextPort } from './context/assemble.js'
import { createCanonicalRunLoader,requirePreparedCapabilities } from './context/prepare.js'
import type { CanonicalRunContext,ReplyClassificationContext } from './models.js'
import type { CanonicalContextPorts,CanonicalRunPreparationPorts,AgentRunnerPorts } from './ports.js'
import { createPortableReplyPolicy } from './run/lifecycle.js'
import { createAgentRunner } from './core.js'

/** 完整Core组合入口；Host只装配真实边界，不复制上下文/语言守卫/执行编排。 */
export function createCanonicalRunner(ports: {
  context: CanonicalContextPorts
  /** 推荐标准准备链；省略时context.load必须提供已完整准备的可信能力与前缀。 */
  runPreparation?: CanonicalRunPreparationPorts
  executor: HarnessExecutorPorts
  runtime: Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply'>
  replyContext?(context: CanonicalRunContext): ReplyClassificationContext | Promise<ReplyClassificationContext>
}) {
  return createAgentRunner({
    ...ports.runtime,
    context: createCanonicalContextPort(ports.runPreparation ? {
      ...ports.context,
      observation: ports.runtime.observation,
      load: createCanonicalRunLoader(ports.context.load, ports.runPreparation, {
        ...ports.context.preparation, digest: ports.context.digest, nextId: ports.context.nextId,
      }, ports.runtime.observation),
    } : { ...ports.context, observation: ports.runtime.observation, load: requirePreparedCapabilities(ports.context.load) }),
    execution: createHarnessExecutor(ports.executor),
    observationSnapshot(context) {
      const area = context.prepared.area
      return {
        revision: area.revision, digest: area.digest,
        entries: area.entries.map(entry => ({ sequence: entry.sequence, source: entry.source,
          persistencePolicy: entry.persistencePolicy, message: entry.message })),
      }
    },
    toolSchemaSnapshot(context, toolName) {
      return context.capabilities?.tools.find(tool => tool.name === toolName)?.schema ?? null
    },
    reply: createPortableReplyPolicy({ context: ports.replyContext ?? ((context) => context.replyContext) }),
  })
}
