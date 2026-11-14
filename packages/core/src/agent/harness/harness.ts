
import type { HarnessExecutorPorts } from '../executor/contracts.js'
import { createHarnessExecutor } from '../executor/executor.js'
import { createCanonicalContextPort } from './context/assemble.js'
import { createCanonicalRunLoader,requirePreparedCapabilities } from './context/prepare.js'
import type { CanonicalHarnessContext,ReplyClassificationContext,RunHarness } from './contracts.js'
import type { CanonicalContextPorts,CanonicalRunPreparationPorts,HarnessPorts } from './ports.js'
import { createPortableReplyPolicy } from './run/lifecycle.js'
import { createRunCoordinator } from './streaming/coordinator.js'

/** 完整Core组合入口；Host只装配真实边界，不复制上下文/语言守卫/执行编排。 */
export function createCanonicalHarness(ports: {
  context: CanonicalContextPorts
  /** 推荐标准准备链；省略时context.load必须提供已完整准备的可信能力与前缀。 */
  runPreparation?: CanonicalRunPreparationPorts
  executor: HarnessExecutorPorts
  runtime: Omit<HarnessPorts<CanonicalHarnessContext>, 'context' | 'execution' | 'reply'>
  replyContext?(context: CanonicalHarnessContext): ReplyClassificationContext | Promise<ReplyClassificationContext>
}) {
  return createRunHarness({
    ...ports.runtime,
    context: createCanonicalContextPort(ports.runPreparation ? {
      ...ports.context,
      load: createCanonicalRunLoader(ports.context.load, ports.runPreparation, {
        ...ports.context.preparation, digest: ports.context.digest, nextId: ports.context.nextId,
      }),
    } : { ...ports.context, load: requirePreparedCapabilities(ports.context.load) }),
    execution: createHarnessExecutor(ports.executor),
    reply: createPortableReplyPolicy({ context: ports.replyContext ?? ((context) => context.replyContext) }),
  })
}

export function createRunHarness<C>(ports: HarnessPorts<C>): RunHarness<C> { return createRunCoordinator(ports) }
