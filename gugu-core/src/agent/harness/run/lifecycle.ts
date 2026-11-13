
import type { GuardLocale,ReplyChoice,ReplyClassificationContext,ReplyDecision,ReplyFacts,ReplyGateCall,ReplyState,RunCheckpoint,RunIdentity,RunStatus,Usage } from '../contracts.js'
import { HarnessError } from '../contracts.js'
import type { HarnessPorts,ReplyPolicy } from '../ports.js'

export const initialReplyState: ReplyState = Object.freeze({
  emptyRetries: 0, anyToolCalled: false, narrationRetries: 0, decisionRetries: 0,
  intentRetries: 0, colonRetries: 0, toolIntentRetries: 0, guardPending: false, colonPending: false,
})

/** 沿用Python各Provider共用的空答追问，必须进入下一轮请求而不是只增加计数。 */
export const EMPTY_REPLY_NUDGE = '（把要回复用户的话直接说出来就好，别只在心里想。）'

/** 与 Python ReplyRuntime 相同的跨轮优先顺序；语言分类与文案由策略端口提供。 */
export function decideReply(state: ReplyState, facts: ReplyFacts): ReplyDecision {
  if (state.guardPending) {
    const visible = state.colonPending && !facts.empty && !facts.endsWithColon && !facts.narration && !facts.announcesIntent && !facts.toolProgressOnly && !facts.requiresTools
    return { state: { ...state, guardPending: false, colonPending: false }, action: 'complete', visible: visible ? 'original' : 'suppressed' }
  }
  if (facts.empty) {
    if (state.emptyRetries < 2)
      return { state: { ...state, emptyRetries: state.emptyRetries + 1 }, action: 'retry', retryKind: 'empty', prompt: EMPTY_REPLY_NUDGE, visible: 'suppressed' }
    return { state, action: 'complete', visible: 'fallback' }
  }
  let retry: {
    key: 'narrationRetries' | 'intentRetries' | 'colonRetries' | 'toolIntentRetries' | 'decisionRetries'
    prompt: string
  } | undefined
  if (!state.anyToolCalled && state.narrationRetries < 1 && facts.narration)
    retry = { key: 'narrationRetries', prompt: facts.prompts.narration }
  else if (state.intentRetries < 1 && facts.announcesIntent)
    retry = { key: 'intentRetries', prompt: facts.prompts.intent }
  else if (state.colonRetries < 1 && facts.endsWithColon)
    retry = { key: 'colonRetries', prompt: facts.prompts.colon }
  else if (!state.anyToolCalled && state.toolIntentRetries < 1 && (facts.requiresTools || facts.toolProgressOnly))
    retry = { key: 'toolIntentRetries', prompt: facts.prompts.tools }
  else if (!state.anyToolCalled && facts.decisionGuardEnabled && state.decisionRetries < 1 && facts.decisionDodge)
    retry = { key: 'decisionRetries', prompt: facts.prompts.decision }
  if (retry)
    return { state: { ...state, [retry.key]: state[retry.key] + 1, guardPending: true, colonPending: retry.key === 'colonRetries' }, action: 'retry', retryKind: 'guard', prompt: retry.prompt, visible: 'suppressed' }
  return { state, action: 'complete', visible: 'original' }
}

export function toolReplyProgress(state: ReplyState, successful = false): ReplyState {
  return { ...state, anyToolCalled: true, guardPending: false, colonPending: false, emptyRetries: successful ? 0 : state.emptyRetries }
}

export const GOAL_DONE_MARKER = '<!-- GUGU_GOAL_DONE -->'

export function goalCompleted(text: string): boolean { return text.includes(GOAL_DONE_MARKER) }

export function stripGoalMarker(text: string): string { return text.replaceAll(GOAL_DONE_MARKER, '').trimEnd() }

/** 群被动回复门由代码决定：纯工具轮保留拒绝机会，实际正文锁定reply，同批静默阻断其他业务。 */
export function decideReplyGate(choice: ReplyChoice, text: string, calls: readonly {
  readonly id: string
  readonly kind: ReplyGateCall
}[]) {
  if (choice === 'disabled')
    return {
      choice, blocked: [] as readonly {
        readonly id: string
        readonly code: string
      }[]
    }
  const declined = choice === 'pending' && calls.some((call) => call.kind === 'decline')
  const next: ReplyChoice = declined ? 'silent' : choice === 'pending' && text.trim() ? 'reply' : choice
  return {
    choice: next,
    blocked: calls.flatMap((call) => {
      if (call.kind === 'invalid')
        return []
      if (declined && call.kind === 'business')
        return [{ id: call.id, code: 'group_reply_silent' }]
      if ((choice === 'reply' || choice === 'silent') && call.kind === 'decline')
        return [{ id: call.id, code: 'group_reply_already_started' }]
      return []
    }),
  }
}

// Python Unicode \b按字母/数字/下划线分界；JS内置\b只按ASCII，不能让混合语言前缀变成误报。
export const unicodeBoundary = String.raw`(?:(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_]))`

export function english(source: string): RegExp { return new RegExp(source.replaceAll(String.raw`\b`, unicodeBoundary), 'iu') }

export const zh: GuardLocale = Object.freeze({
  locale: 'zh-CN',
  narration: /让我(先|再|现在)?(读|看|查|改|滚动|翻)|我(来|先)?(读|看|查|改)(了)?一?下|读到了(?:文件|内容|正文|结果|项目|目录|记录)|看到了(?:文件|内容|正文|结果|项目|目录|图片|记录)|改好了|改成了|文件里(是|有|写)|(?:(?:我|咕咕|已经替你|已替你|刚刚替你|为你)(?:已经?|刚刚)?\s*)(建好|建了|创建|新建|保存|存好|存进|删除|删了|删掉|发送|发出|发了|移好|移到|移了|归档|重命名|改名)|(帮你|给你|这就)(建|创建|新建|保存|存|删除?|删掉|发送|发出|移|归档|重命名|改名)(了|啦|好了?|成功|完成)|(建好|创建好|新建好|保存好|存好|删掉|删除|发出去|移好|归档好)了|(?:(?:我|咕咕|已经替你|已替你|刚刚替你|为你)(?:已经?|刚刚)?\s*)(保存|创建|新建|删除|发送|发出|移动|归档)(成功|完成|了|啦|好了?)|已经?是.{0,12}(格式|样子|状态|结构)了/u,
  actionRequest: /排序|重排|排个?序|重新排|置顶|归档|改成|改为|改一?下|调整|换成|换个|改名|重命名|设为|设成|标记为?|标为|分类|删掉|删除|加上|加个|添加|移到|移动|整理一?下|重新(排|命名|整理)/u,
  refusal: /不需要(再)?(改|调|动|排|加|删|整理|创建|修改|添加|删除|移动)|不用(改|调|动|排|加|删|整理)|没必要(再)?(改|调|动|排|加|删|整理|创建|修改|添加|删除|移动)|无需(再)?(调整|改动|改|整理|创建|修改|添加|删除|移动)|不必(再)?(改|调|动|排|加|删|整理)|已经(很|挺|够|蛮)?(合理|好了?|不错|可以|没问题|对了?|清晰|清楚)|保持(现状|原样|不变)|维持原样|现状.{0,4}(挺好|够好|合理|可以)|没什么(好|要)改|不建议(改|动)/u,
  intent: /(我(这就|马上|现在|先|稍后)?(去|来)|我(先|这就|马上|现在|稍后)|(?<!你)(这就|马上|现在|稍后)(去|帮你|帮您|给你|来)?|稍等[，,]?\s*我?(去|来)?|让我(去|来|先)?|接下来我?(去|来)?|那我(去|来|就))(帮你|帮您|给你|重新|再)?\s*(查|搜索?|找|看|读|翻|问|建|创建|新建|做|改|修改|删除?|发送?|存|保存|记录?|整理|安排|设置?|调取?|生成|算|统计)/u,
  question: /[?？]|吗|呢|要不要|需不需要|好不好|可不可以|行不行|是否|要我帮|需要我/u,
  toolProgressPrefixes: Object.freeze(['正在为你查询最新信息', '正在查询最新信息', '正在为你搜索最新信息', '我去查一下', '我去搜索一下', '我来查一下', '我拿这张图找找相似结果']),
  prompts: Object.freeze({
    narration: '【系统提醒 · 缺少工具回执】你刚才声称做了某个操作，但本轮没有调用对应工具。请不要在缺少回执时给出操作结果；现在调用对应工具执行。',
    intent: '【系统提醒 · 你说了要做却没动手】你刚表示要去做某件事，但本轮没有调用对应工具。请现在完成工具调用，不要只停留在行动宣告。',
    decision: '【系统提醒 · 检查是否遗漏了明确操作请求】只依据引用内容之后的本轮用户正文判断。若用户明确要求执行，请调用合适工具；若用户只是在讨论方案、询问是否可行或意思不明确，请正常回答或先询问，不要把讨论当成执行授权。',
    tools: '你上一轮只输出了进度提示，没有实际调用工具。请立即调用合适的工具完成用户请求；如果确实无法调用工具，请明确说明原因。',
    colon: '你上一条回复以冒号结束，内容可能还没说完。请继续完整回应用户；如果完成请求需要工具就调用工具，否则直接补完说明。不要只重复前面的半句话。',
  }),
})

export const en: GuardLocale = Object.freeze({
  locale: 'en-US',
  narration: english(String.raw`\b(?:I|I've|I have|we|we've|we have)\s+(?:read|checked|looked at|updated|created|saved|deleted|sent|moved|archived|renamed)\b|\b(?:done|completed|saved successfully|created successfully|updated successfully)\b`),
  actionRequest: english(String.raw`\b(?:sort|reorder|pin|archive|change|rename|delete|add|move|organize|update|edit)\b`),
  refusal: english(String.raw`\b(?:no need to (?:sort|reorder|pin|archive|change|rename|delete|add|move|organize|update|edit)|don't need to (?:sort|reorder|pin|archive|change|rename|delete|add|move|organize|update|edit)|not necessary to (?:sort|reorder|pin|archive|change|rename|delete|add|move|organize|update|edit)|leave it as is|already (?:fine|good|done|correct))\b`),
  intent: english(String.raw`\b(?:let me|i(?:'ll| will| am going to)|next i'll|then i'll)\b.*\b(?:check|search|read|create|save|delete|send|move|rename|edit|update|organize)\b`),
  question: english(String.raw`\?|\b(?:should i|do you want|would you like|can i|shall i|is it necessary)\b`),
  toolProgressPrefixes: Object.freeze(['Searching for the latest information', 'Checking now', 'Let me look that up']),
  prompts: Object.freeze({
    narration: '[System reminder: missing tool receipt] You claimed to perform an operation, but this round contains no matching tool call. Do not report an unverified result; call the appropriate tool now or explain why it cannot be done.',
    intent: '[System reminder: action announced but not performed] You said you would perform an action, but made no tool call. Complete the tool call now, or ask for the missing confirmation or information.',
    decision: '[System reminder: check for an omitted explicit action request] Judge only the current user text, not quoted history. If the user explicitly asked you to perform an action, call the appropriate tool. If they are discussing an option, asking whether it is possible, or their intent is unclear, answer or ask first; do not treat discussion as authorization.',
    tools: 'Your previous turn only gave a progress update and made no tool call. Call the appropriate tool now, or clearly explain why it cannot be called.',
    colon: 'Your previous reply ended with a colon and may be incomplete. Finish responding to the user; call a tool if the request requires one, otherwise complete the explanation. Do not merely repeat the fragment.',
  }),
})

export const ja: GuardLocale = Object.freeze({
  locale: 'ja-JP',
  narration: /(?:読みました|確認しました|見つけました|変更しました|作成しました|保存しました|削除しました|送信しました|移動しました|完了しました|更新しました)/u,
  actionRequest: /(?:並べ替え|並び替え|固定|アーカイブ|変更|名前変更|削除|追加|移動|整理|更新|編集)/u,
  refusal: /(?:変更する必要はありません|並べ替える必要はありません|削除する必要はありません|追加する必要はありません|移動する必要はありません|変更しなくて|そのままで|すでに(?:問題ありません|完了しています|適切です))/u,
  intent: /(?:これから|今から|すぐに|次に|確認します|調べます|作成します|変更します|削除します|移動します|更新します)/u,
  question: /[?？]|(?:ですか|ますか|でしょうか|必要ですか)/u,
  toolProgressPrefixes: Object.freeze(['最新情報を検索しています', '確認しています', '調べてみます']),
  prompts: Object.freeze({
    narration: '【システム通知・ツールの結果がありません】操作を実行したと述べましたが、対応するツール呼び出しがありません。対応するツールを呼び出すか、実行できない理由を説明してください。',
    intent: '【システム通知・宣言した操作が未実行です】操作を行うと述べましたが、ツール呼び出しがありません。今すぐツールを呼び出すか、不足している確認や情報を質問してください。',
    decision: '【システム通知・明確な操作依頼の見落としを確認してください】引用履歴ではなく、今回のユーザー本文だけを判断してください。明確な実行依頼なら適切なツールを呼び出してください。案の相談、可否の質問、意図が不明な場合は通常どおり回答または確認し、相談を実行許可と解釈しないでください。',
    tools: '前のターンは進捗だけで、実際のツール呼び出しがありません。適切なツールを呼び出すか、呼び出せない理由を明確に説明してください。',
    colon: '前の返信はコロンで終わっており、内容が未完了の可能性があります。ユーザーへの回答を最後まで続けてください。依頼の完了にツールが必要なら呼び出し、不要なら説明を補ってください。断片を繰り返すだけにしないでください。',
  }),
})

export function getGuardLocale(locale?: string | null): GuardLocale {
  const normalized = (locale || 'zh-CN').replaceAll('_', '-').toLowerCase()
  return normalized === 'en-us' ? en : normalized === 'ja-jp' ? ja : zh
}

export const EMPTY_REPLY_FALLBACK = '嗯…我这下没太接住，你再说一遍、或者换个说法，我马上跟上～'

export function looksLikeNarration(text: string | null | undefined, locale?: string | null): boolean {
  return !!text && getGuardLocale(locale).narration.test(text)
}

export function announcesIntent(text: string | null | undefined, locale?: string | null): boolean {
  if (!text)
    return false
  const policy = getGuardLocale(locale)
  return !policy.question.test(text) && policy.intent.test(text)
}

export function endsWithColon(text: string | null | undefined): boolean { return /[:：]\s*$/u.test(text || '') }

export function guardText(text: string | null | undefined): string { return (text || '').replace(/[\s\u3000，。！？、:：….!?]+/gu, '') }

export function couldBeToolProgress(text: string | null | undefined, locale?: string | null): boolean {
  const normalized = guardText(text)
  return !!normalized && getGuardLocale(locale).toolProgressPrefixes.some(prefix => guardText(prefix).startsWith(normalized))
}

export function isToolProgressOnly(text: string | null | undefined, locale?: string | null): boolean {
  const normalized = guardText(text)
  return !!normalized && getGuardLocale(locale).toolProgressPrefixes.some(prefix => guardText(prefix) === normalized)
}

export function isDecisionDodge(userRequest: string | null | undefined, reply: string | null | undefined, locale?: string | null): boolean {
  const policy = getGuardLocale(locale)
  if (!userRequest || !reply || policy.question.test(reply))
    return false
  let request = userRequest
  const prefix = '💬 用户引用/回复了一条历史消息（原文：「', marker = '），针对这条消息说：\n\n'
  const quoteStart = request.indexOf(prefix)
  if (quoteStart >= 0) {
    const quoted = request.slice(quoteStart), index = quoted.indexOf(marker)
    if (index >= 0)
      request = quoted.slice(index + marker.length)
  }
  return !!request.trim() && policy.actionRequest.test(request) && policy.refusal.test(reply)
}

export function classifyReply(text: string, context: ReplyClassificationContext): ReplyFacts {
  const policy = getGuardLocale(context.locale)
  return {
    empty: !text.trim(), narration: looksLikeNarration(text, context.locale), announcesIntent: announcesIntent(text, context.locale),
    endsWithColon: endsWithColon(text), toolProgressOnly: isToolProgressOnly(text, context.locale), requiresTools: context.requiresTools === true,
    decisionDodge: isDecisionDodge(context.userRequest, text, context.locale), decisionGuardEnabled: context.decisionGuardEnabled === true,
    prompts: policy.prompts, emptyFallback: EMPTY_REPLY_FALLBACK
  }
}

/** locale/本轮正文/显式偏好由可信上下文注入，文字规则始终在可移植Core内执行。 */
export function createPortableReplyPolicy<C>(ports: {
  context(context: C): ReplyClassificationContext | Promise<ReplyClassificationContext>
  evaluate?(text: string, context: C): Promise<'accept' | 'retry' | 'silent'>
}): ReplyPolicy<C> {
  return {
    evaluate: (text, context) => ports.evaluate ? ports.evaluate(text, context) : Promise.resolve('accept'),
    classify: async (text, context, roundFacts) => {
      const metadata = await ports.context(context)
      return classifyReply(text, { ...metadata, ...(roundFacts === undefined ? {} : { requiresTools: roundFacts.requiresTools === true }) })
    }
  }
}

/** 核验轮的过程占位词不等于结果摘要；不访问Provider、存储或当前墙钟。 */
export function isVerifyPlaceholder(text: string | null | undefined): boolean {
  const normalized = (text || '').replace(/[\s，。！？、,.!?：:；;‘’“”"'`~～…]+/gu, '')
  return !normalized || [...normalized].length <= 16 && ['确认一下', '核实一下', '检查一下', '看一下', '查一下', '正在核实', '正在检查', '正在确认', '已核实',
    '已确认', '核对完成', '复查完成', '都核实过了', '没问题'].some(phrase => normalized.includes(phrase))
}

export const emptyRunUsage: Usage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null })

export const terminalRunStates = new Set<RunStatus>(['completed', 'cancelled', 'failed', 'unknown'])

/** 重放不重新开Run；准备不能直接等待交互，非准备状态不能退回准备。 */
export function assertRunTransition(previous: RunStatus, next: RunStatus): void {
  if (previous === next) return
  if (terminalRunStates.has(previous) || next === 'preparing' || previous === 'preparing' && next === 'waiting')
    throw new HarnessError('invalid_state', '运行状态转换无效')
}

export const sameRunIdentity = (left: RunIdentity, right: RunIdentity): boolean => left.ownerId === right.ownerId && left.sessionId === right.sessionId && left.runId === right.runId

export function runIdentityKey(identity: RunIdentity): string {
  return JSON.stringify([identity.ownerId, identity.sessionId, identity.runId])
}

export function assertRunIdentity(identity: RunIdentity): void {
  if (![identity.ownerId, identity.sessionId, identity.runId].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 256)) {
    throw new HarnessError('invalid_state', '运行身份无效')
  }
}

export function assertRunCheckpoint<C>(identity: RunIdentity, checkpoint: RunCheckpoint<C>): void {
  if (!sameRunIdentity(identity, checkpoint.identity))
    throw new HarnessError('not_found', '运行不存在')
  if (!Number.isSafeInteger(checkpoint.version) || checkpoint.version < 0 || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0 || !Number.isSafeInteger(checkpoint.round) || checkpoint.round < 0 || !['preparing', 'running', 'waiting', 'completed', 'cancelled', 'failed', 'unknown'].includes(checkpoint.status) || !['prepare', 'provider', 'tools', 'decision', 'idle'].includes(checkpoint.phase)) {
    throw new HarnessError('invalid_state', '运行检查点无效')
  }
}

export async function readRunCheckpoint<C>(ports: HarnessPorts<C>, identity: RunIdentity): Promise<RunCheckpoint<C>> {
  assertRunIdentity(identity)
  identity = Object.freeze({ ...identity })
  let checkpoint: RunCheckpoint<C> | null
  try {
    checkpoint = await ports.store.read(identity)
  }
  catch {
    throw new HarnessError('persistence_unknown', '运行状态读取失败，请重新查询')
  }
  if (!checkpoint)
    throw new HarnessError('not_found', '运行不存在')
  assertRunCheckpoint(identity, checkpoint)
  if (checkpoint.context !== null)
    ports.context.assertIdentity(identity, checkpoint.context)
  return checkpoint
}
