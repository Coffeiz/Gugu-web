import type { AssertScheduledTaskLease } from './runner.js'
import type { ScheduledTaskExecutionPlan } from './run-now-read.js'
import type { AgentRunner, RunCheckpoint, RunIdentity } from '../agent/models.js'
import type { ToolDefinition } from '../agent/tools/contracts.js'

type Outcome<Artifact> = { text: string; status: 'success' | 'failed'; files: readonly Artifact[] }
type Attempt<Artifact> = Outcome<Artifact> & {
  /** 只有执行器确认未产生副作用时，失败才允许重试。 */
  effects: 'none' | 'possible'
  unresolvedToolErrors?: boolean
}

const fileDeliveryChannels = new Set(['email', 'feishu', 'qq', 'wechat', 'telegram', 'im'])

/** 只有可接收结果文件的渠道才向定时 Agent 提供 send_item。 */
export function scheduledTaskSupportsFileDelivery(channels: readonly string[]): boolean {
  return channels.some(channel => fileDeliveryChannels.has(channel))
}

export interface RecurringStopExecution<Artifact> {
  deliver(outcome: Outcome<Artifact>, assertLease?: AssertScheduledTaskLease, noticeTitle?: string): Promise<Record<string, string>>
  disable(assertLease?: AssertScheduledTaskLease): Promise<boolean>
  notifyChanged(): Promise<void>
}

export interface ScheduledTaskExecutionPorts<Artifact> {
  attempt?(input: { task: ScheduledTaskExecutionPlan; prompt: string; isTrial: boolean
    assertLease?: AssertScheduledTaskLease
    toolsForRun?(identity: RunIdentity): readonly ToolDefinition[]
  }): Promise<Attempt<Artifact>>
  deliver(task: ScheduledTaskExecutionPlan, outcome: Outcome<Artifact>, assertLease?: AssertScheduledTaskLease): Promise<Record<string, string>>
  loadGroupMemory?(task: ScheduledTaskExecutionPlan): Promise<string>
  toolsForRun?(task: ScheduledTaskExecutionPlan, identity: RunIdentity): readonly ToolDefinition[]
  now?(): Date
  timeZone?: string
}

type AttemptInput = Parameters<NonNullable<ScheduledTaskExecutionPorts<unknown>['attempt']>>[0]

/** 从共享 Harness 的最终 checkpoint 读取正文、附件和实际副作用回执。 */
export function createScheduledTaskAgentAttempt<Context>(
  prepare: (input: AttemptInput) => Promise<{
    identity: RunIdentity
    harness: Pick<AgentRunner<Context>, 'start'>
    hasUnresolvedToolErrors?(): boolean
    recordUsage?(checkpoint: RunCheckpoint<Context>): Promise<void>
    close(): Promise<void>
  }>,
): NonNullable<ScheduledTaskExecutionPorts<unknown>['attempt']> {
  return async input => {
    const { identity, harness, recordUsage, hasUnresolvedToolErrors, close } = await prepare(input)
    try {
      if (identity.ownerId !== input.task.ownerId) throw new Error('定时任务执行身份不匹配')
      const run = harness.start(identity, { scheduled: true })
      let next = await run.next()
      while (!next.done) next = await run.next()
      const state = next.value
      if (state.identity.ownerId !== identity.ownerId || state.identity.sessionId !== identity.sessionId || state.identity.runId !== identity.runId)
        throw new Error('定时任务执行身份不匹配')
      await recordUsage?.(state)
      if (state.remoteStatusUnknown || (state.status !== 'completed' && state.status !== 'failed'))
        throw new Error('定时任务执行未正常结束')
      return {
        text: state.text,
        status: state.status === 'completed' ? 'success' : 'failed',
        effects: state.mutated ? 'possible' : 'none',
        files: state.files,
        ...(hasUnresolvedToolErrors?.() ? { unresolvedToolErrors: true } : {}),
      }
    } finally { await close() }
  }
}

function describeChannels(channels: readonly string[]): string {
  const labels: string[] = []
  if (channels.includes('web') || channels.includes('chat')) labels.push('网页通知')
  if (channels.includes('email')) labels.push('注册邮箱')
  for (const [key, label] of [['feishu', '飞书'], ['qq', 'QQ'], ['wechat', '微信'], ['telegram', 'Telegram']] as const) {
    if (channels.includes(key)) labels.push(label)
  }
  if (channels.includes('im')) labels.push('已配置的即时通讯平台')
  return labels.length ? labels.join('、') : '未指定渠道'
}

function buildPrompt(task: ScheduledTaskExecutionPlan, time: string): string {
  return [
    `[定时任务触发：${task.name}]`,
    `现在是 ${time}，用户设置了一条定时任务：${task.payload}`,
    `本轮消息将由系统投递到：${describeChannels(task.channels)}。`,
    '请以咕咕的身份完成这项任务，只生成要发给用户的正文。文字部分不需要你自己调用 IM 发送/推送工具（系统会自动把正文投递到已配置的渠道），也不要提及渠道、推送、工具不可用或无法发送。',
    '如果任务需要配图/发图，只有在本轮存在可用图片来源或生成能力时才通过 send_item 实际发送；不要在正文里用 ![]() 这类 markdown 图片语法或「[图片]」占位符——那样发不出真图，图片必须靠 send_item 实际发送。',
    '汇报要求：结果必须具体——有数据的给实际数字、日期、名称，不要空泛地说「已完成」「查了一下」；查不到或没做完的部分直接说明原因，不要为了完整而编造或凑数。任务本身很简单时，一两句话自然汇报即可，不要强行套条目。',
  ].join('\n')
}

const allowedEmoji = new Set('✅✔☑💡📌📎📝📄📅📆🗓⏰⏳⌛🔍🔎🎉🎊📂📁🗂📊📈📉🔔💬🗨')
const scheduledEmoji = /[ 　]?([\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\u2300-\u23FF\u{1F1E6}-\u{1F1FF}])[\uFE00-\uFE0F\u200D]*/gu

function recurringStopTool(requestStop: () => void): ToolDefinition {
  return {
    definition: { name: 'stop_recurring', schema: { type: 'function', function: {
      name: 'stop_recurring',
      description: '仅当整个周期目标已经达成且未来无需继续时请求停用。单轮检查、报告或提醒完成时不要调用。请求不会中断这一轮。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    } } },
    effect: 'read',
    validate(input) {
      return input !== null && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0
        ? { success: true, data: {} } : { success: false }
    },
    async execute(_input, scope) {
      scope.signal.throwIfAborted()
      requestStop()
      return { kind: 'completed', successful: true, mutated: false,
        value: { status: 'requested', message: '已登记停止当前周期任务后续执行的请求；当前一轮仍会继续。' } }
    },
  }
}

const stopDeliveryLabels = new Map([
  ['email', '邮件'], ['web', 'web 通知'], ['chat', 'web 通知'],
  ['feishu', '飞书'], ['qq', 'QQ'], ['wechat', '微信'], ['telegram', 'Telegram'],
])
function allDeliveriesSucceeded(channels: readonly string[], result: Record<string, string>): boolean {
  if (!channels.length || Object.hasOwn(result, '错误')) return false
  const labels = channels.flatMap(channel => channel === 'im'
    ? ['飞书', 'QQ', '微信', 'Telegram'] : [stopDeliveryLabels.get(channel)])
  return labels.every(label => label !== undefined
    && (result[label] === '已发送' || result[label] === '已保存（实时提示失败）'))
}

/** 按 Python 定时执行规则最多重试一次，再将末轮正文和附件交给投递端口。 */
export function createScheduledTaskExecution<Artifact>(ports: ScheduledTaskExecutionPorts<Artifact>) {
  const clock = new Intl.DateTimeFormat('sv-SE', { timeZone: ports.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return async (task: ScheduledTaskExecutionPlan, isTrial: boolean, assertLease?: AssertScheduledTaskLease,
    recurringStop?: RecurringStopExecution<Artifact>): Promise<Record<string, string>> => {
    const stop = isTrial ? undefined : recurringStop
    if (task.executionMode === 'reminder') {
      await assertLease?.()
      const outcome: Outcome<Artifact> = { text: task.payload, status: 'success', files: [] }
      return stop ? stop.deliver(outcome, assertLease) : ports.deliver(task, outcome, assertLease)
    }
    const runAgent = ports.attempt
    if (!runAgent) throw new Error('定时任务的模型执行能力暂不可用')
    const instruction = buildPrompt(task, clock.format(ports.now?.() ?? new Date()))
    const attempt = async () => {
      const memory = task.groupScope ? await ports.loadGroupMemory?.(task) : ''
      const prompt = memory ? `${memory}\n\n${instruction}` : instruction
      let requested = false
      const stopTool = stop ? recurringStopTool(() => { requested = true }) : undefined
      const groupTools = task.groupScope ? ports.toolsForRun : undefined
      await assertLease?.()
      const result = await runAgent({ task, prompt, isTrial, ...(assertLease ? { assertLease } : {}),
        ...(groupTools || stopTool ? {
          toolsForRun: (identity: RunIdentity) => [
            ...(groupTools?.(task, identity) ?? []), ...(stopTool ? [stopTool] : []),
          ],
        } : {}),
      })
      return { ...result, stopRequested: requested && !result.unresolvedToolErrors }
    }
    const first = await attempt()
    const last = first.status === 'failed' && first.effects === 'none' ? await attempt() : first
    const text = last.text || first.text || '咕咕这次没有产出内容'
    await assertLease?.()
    const outcome: Outcome<Artifact> = {
      text: text.replace(scheduledEmoji, (match, emoji: string) => allowedEmoji.has(emoji) ? match : ''),
      status: last.status,
      files: last.files.length ? last.files : first.files,
    }
    if (!stop) return assertLease ? ports.deliver(task, outcome, assertLease) : ports.deliver(task, outcome)
    const result = await stop.deliver(outcome, assertLease)
    if (last.status !== 'success' || !last.stopRequested || !allDeliveriesSucceeded(task.channels, result)) return result
    await assertLease?.()
    if (!await stop.disable(assertLease)) return result
    try { await stop.notifyChanged() } catch { /* 停用已提交，实时面板刷新尽力而为。 */ }
    try {
      await assertLease?.()
      await stop.deliver({
        status: 'success', files: [],
        text: `⏹️ 周期定时任务「${task.name}」已停用，后续不会自动执行。任务记录未被立即删除；如需删除，可在定时任务页面手动删除，或直接告诉咕咕。`,
      }, assertLease, `${task.name}（已停用）`)
    } catch { /* 通知失败不恢复已经停用的任务。 */ }
    return result
  }
}
