import { prepareQqText, completeQqLines, prepareQqLinkButtonMessage, type QqLinkButton } from '@gugu/core/im/qq-text'
import { validateLinkButtons } from '@gugu/core/tools'
import { setTimeout as delay } from 'node:timers/promises'
import { QqApiError, type createQqClient } from './client.js'
import { z } from 'zod'
import {createHash} from 'node:crypto'

type Outcome = 'accepted' | 'rejected' | 'unknown'
export interface QqReceipt { outcome: Outcome; platformMessageIds: readonly string[] }
export interface QqTarget {
  id: string
  chatType: 'c2c' | 'group'
  messageId?: string
  messageFormat?: 'compat' | 'markdown'
  mentionUserId?: string
  /** 仅接受Host从当前群授权资料读取的名单。 */
  knownMemberIds?: readonly string[]
}
export interface QqSequencePort {
  /** Host必须Redis原子INCR+仅首次EXPIRE；普通消息、媒体和流首帧共用同一键。 */
  nextPassive(input: { botId: string; messageId: string; ttlSeconds: 4200 }): Promise<number>
  /** 没有被动msg_id的独立流使用共享持久计数，禁止本地时间戳兜底。 */
  nextStream(input: { botId: string; ttlSeconds: 600 }): Promise<number>
}
export interface QqStreamReceipt extends QqReceipt { closed: boolean; reason?: 'prefix-mismatch'; definitelyUnsent?: true }
const streamSnapshotSchema=z.object({v:z.literal(1),binding:z.string().regex(/^[a-f0-9]{64}$/),fullText:z.string().max(1048576),lastSentText:z.string().max(1048576),lastSentContent:z.string().max(1048576),
 streamId:z.string().min(1).max(256).regex(/^[^\r\n\0]+$/).nullable(),msgSeq:z.number().int().positive().safe().nullable(),index:z.number().int().nonnegative().safe(),
 finished:z.boolean(),closed:z.boolean(),failed:z.boolean(),rejectedContent:z.boolean(),flushInterval:z.number().int().min(500).max(2000)}).strict()
export type QqStreamSnapshot=z.infer<typeof streamSnapshotSchema>
export function parseQqStreamSnapshot(input:unknown):QqStreamSnapshot{
 const value=streamSnapshotSchema.parse(input)
 if(Buffer.byteLength(JSON.stringify(value))>1048576||value.index>0&&(!value.streamId||!value.msgSeq)||value.index===0&&(value.streamId!==null||value.lastSentContent!==''||value.lastSentText!=='')||value.closed&&(!value.finished||value.index===0))throw new Error('QQ 流式恢复状态无效')
 return value
}
/** 必须来自统一交互服务的可信投影，不能从模型工具参数创建或补充token。 */
export interface QqInteractionPrompt {
  prompt_id: number
  title?: string
  body?: string
  task_paused?: boolean
  allow_text_input?: boolean
  native_keyboard?: boolean
  secret_fields?: readonly unknown[]
  group_secret_blocked?: boolean
  resolved?: boolean
  options?: readonly { id?: string; label?: string; token?: string }[]
}
export interface QqButtonReceipt extends QqReceipt { delivery: 'native' | 'text' | 'none'; buttonCount: number }
const clip = (text: string, size: number): string => [...text].slice(0, size).join('')
function validatePrompt(prompt: QqInteractionPrompt): void {
  if (!Number.isSafeInteger(prompt.prompt_id) || prompt.prompt_id <= 0 || prompt.options !== undefined && !Array.isArray(prompt.options) ||
    [prompt.title, prompt.body].some(value => value !== undefined && typeof value !== 'string') ||
    (prompt.options ?? []).some(option => !option || typeof option !== 'object' || [option.id, option.label, option.token].some(value => value !== undefined && typeof value !== 'string') || option.token?.includes(':')))
    throw new Error('QQ 交互提示格式无效')
}
function packButtons(buttons: Record<string, unknown>[]): Record<string, unknown> {
  const rows: { buttons: Record<string, unknown>[] }[] = []
  let current: Record<string, unknown>[] = [], units = 0
  for (const button of buttons) {
    const label = (button.render_data as { label: string }).label
    const cost = [...label].reduce((sum, char) => sum + (char.codePointAt(0)! > 0x2E7F ? 2 : 1), 0) + 4
    if (current.length && (current.length >= 5 || units + cost > 40)) { rows.push({ buttons: current }); current = []; units = 0 }
    current.push(button); units += cost
  }
  if (current.length) rows.push({ buttons: current })
  if (rows.length > 5) throw new RangeError('QQ 键盘容量不足')
  return { content: { rows } }
}
export function buildQqKeyboard(prompt: QqInteractionPrompt): Record<string, unknown> {
  validatePrompt(prompt)
  const actions = (prompt.options ?? []).filter(option => option.token)
  return packButtons(actions.map((option, index) => ({ id: `gugu-${prompt.prompt_id}-${index + 1}`,
    render_data: { label: clip(option.label || option.id || '选择', 40), visited_label: '已选择', style: 1 },
    group_id: `gugu-prompt-${prompt.prompt_id}`,
    action: { type: 1, permission: { type: 2 }, click_limit: 1, data: `${prompt.prompt_id}:${option.token}`, unsupport_tips: '请回复选项序号或选项文字' },
  })))
}
/** 只呈现已授权选项，绝不把token、secret字段值或session写进用户说明。 */
export function formatQqInteractionFallback(prompt: QqInteractionPrompt): string {
  validatePrompt(prompt)
  const title = prompt.title || '需要确认', body = prompt.body || '', options = prompt.options ?? []
  const prefix = prompt.task_paused ? '⏸️ 任务已暂停，等待确认。\n' : ''
  if (options.length) {
    const choices = options.map((option, index) => `${index + 1}. ${option.label || option.id || '选项'}`).join('\n')
    let instruction = prompt.native_keyboard ? '请点击下方按钮；若未显示按钮，可回复选项序号或选项文字。' : '请直接回复选项序号或选项文字。'
    if (prompt.allow_text_input) instruction = prompt.native_keyboard
      ? '请点击下方按钮；如需其他回答，请点击“自定义回复”后发送内容；若按钮未显示，可回复选项序号或文字。'
      : '请回复选项序号或选项文字；如需其他回答，请回复“自定义回复”后发送内容。'
    return `${prefix}${title}\n${body}\n${choices}\n${instruction}`
  }
  if (prompt.secret_fields?.length) return `${title}\n${body}\n${prompt.group_secret_blocked
    ? '群聊不接收凭据。请在登录后的私密网页表单中填写，或改用 Bot 私聊。' : '请打开网页继续补全 MCP 凭据。'}`
  return `${prefix}${title}\n${body}\n请在网页中填写后提交。`
}
const reject = (): QqReceipt => ({ outcome: 'rejected', platformMessageIds: [] })
const valid = (value: string): boolean => /^[A-Za-z0-9_-]{1,256}$/.test(value)
const passiveRejected = (error: unknown): boolean => error instanceof QqApiError && error.outcome === 'FAILED_CONFIRMED' &&
  [40034005, 40034024, 40034031, 40034128].includes(error.errorCode ?? 0)
const markdownBlocked = (error: unknown): boolean => error instanceof QqApiError && error.outcome === 'FAILED_CONFIRMED' && [50056, 40034012].includes(error.errorCode ?? 0)
const outcome = (error: unknown): Outcome => error instanceof QqApiError && error.outcome === 'FAILED_CONFIRMED' ? 'rejected' : 'unknown'
function messageId(response: Record<string, unknown>, stream = false): string | null {
  const id = stream ? response.stream_msg_id || response.id : response.id || response.message_id
  return typeof id === 'string' && id.trim() ? id : null
}

/** 只升级可信普通@ID；模型已明确写出的旧mention标签按Python升级。 */
export function splitQqGroupMentions(text: string, userId?: string, known: readonly string[] = []): { mention: string; body: string } {
  let formatted = text.replace(/<@!?([^>\s]+)>/g, (original, id: string) => /[<>"']/.test(id) ? original : `<qqbot-at-user id="${id}" />`)
  const members = new Set([...known, ...(userId ? [userId.trim()] : [])].filter(id => id && !/[<>"']/.test(id)))
  for (const member of members) {
    const escaped = member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    formatted = formatted.replace(new RegExp(`(?<![<@\\p{L}\\p{N}_])[@＠]${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), `<qqbot-at-user id="${member}" />`)
  }
  const pattern = /<qqbot-at-user\s+id="[^"]+"\s*\/>/g
  const mentions = formatted.match(pattern)
  return mentions ? { mention: mentions.join(''), body: formatted.replace(pattern, '').replace(/[ \t]{2,}/g, ' ').trim() } : { mention: '', body: formatted }
}

export function createQqSender(options: {
  botId: string
  client: Pick<ReturnType<typeof createQqClient>, 'call'>
  sequences: QqSequencePort
  /** 复用Host已装配的实际出站清洗，不允许中间帧与最终帧使用不同规则。 */
  sanitizeText(text: string): string
  normalizePrefix?(text: string): string
  sleep?(ms: number, signal?: AbortSignal): Promise<void>
}) {
  if (!options.botId) throw new Error('QQ Bot身份无效')
  async function sequence(target: QqTarget, stream = false): Promise<number> {
    const value = target.messageId ? await options.sequences.nextPassive({ botId: options.botId, messageId: target.messageId, ttlSeconds: 4200 })
      : stream ? await options.sequences.nextStream({ botId: options.botId, ttlSeconds: 600 }) : 1
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('QQ 回复序号无效')
    return value
  }
  function validTarget(target: QqTarget): boolean { return valid(target.id) && ['c2c', 'group'].includes(target.chatType) &&
    (!target.messageId || typeof target.messageId === 'string' && target.messageId.length <= 2048 && !/[\r\n\0]/.test(target.messageId)) }
  const path = (target: QqTarget) => `/v2/${target.chatType === 'group' ? 'groups' : 'users'}/${target.id}/messages`
  async function postText(target: QqTarget, text: string, markdown: boolean, signal?: AbortSignal,authorize?:()=>Promise<boolean>): Promise<string> {
    const body: Record<string, unknown> = { msg_type: markdown ? 2 : 0, msg_seq: await sequence(target), ...(markdown ? { markdown: { content: text } } : { content: text }), ...(target.messageId ? { msg_id: target.messageId } : {}) }
    let response: Record<string, unknown>
    try { response = await options.client.call('POST', path(target), { body, signal,authorize }) }
    catch (error) {
      if (!markdown || !markdownBlocked(error)) throw error
      response = await options.client.call('POST', path(target), { body: { msg_type: 0, content: text, msg_seq: await sequence(target), ...(target.messageId ? { msg_id: target.messageId } : {}) }, signal,authorize })
    }
    const id = messageId(response)
    if (!id) throw new QqApiError('message', 200, undefined, 'UNKNOWN')
    return id
  }
  async function withPassiveFallback<T>(target: QqTarget, work: (target: QqTarget) => Promise<T>): Promise<T> {
    try { return await work(target) }
    catch (error) { if (!target.messageId || !passiveRejected(error)) throw error; return work({ ...target, messageId: undefined }) }
  }
  async function postKeyboard(target: QqTarget, text: string, keyboard: Record<string, unknown>, signal?: AbortSignal,authorize?:()=>Promise<boolean>): Promise<QqReceipt> {
    if (!validTarget(target)) return reject()
    try {
      const result = await options.client.call('POST', path(target), { body: { msg_type: 2,
        markdown: { content: prepareQqText(options.sanitizeText(text)) }, keyboard, msg_seq: await sequence(target),
        ...(target.messageId ? { msg_id: target.messageId } : {}) }, signal,authorize })
      const id = messageId(result)
      return id ? { outcome: 'accepted', platformMessageIds: [id] } : { outcome: 'unknown', platformMessageIds: [] }
    } catch (error) { return { outcome: outcome(error), platformMessageIds: [] } }
  }
  const sender = {
    prepareText(text:string):string{return prepareQqText(options.sanitizeText(text))},
    async text(target: QqTarget, text: string, signal?: AbortSignal,authorize?:()=>Promise<boolean>): Promise<QqReceipt> {
      if (!validTarget(target)) return reject()
      const ids: string[] = []
      try {
          const prepared = sender.prepareText(text)
        const markdown = (target.messageFormat ?? (target.chatType === 'group' ? 'compat' : 'markdown')) === 'markdown'
        if (target.chatType === 'group') {
          const split = splitQqGroupMentions(prepared, target.mentionUserId, target.knownMemberIds)
          if (split.mention) ids.push(await withPassiveFallback(target, actual => postText(actual, split.mention, true, signal,authorize)))
          if (split.body) ids.push(await withPassiveFallback(split.mention ? { ...target, messageId: undefined } : target, actual => postText(actual, split.body, markdown, signal,authorize)))
        } else if (prepared.trim()) ids.push(await withPassiveFallback(target, actual => postText(actual, prepared, markdown, signal,authorize)))
        return ids.length ? { outcome: 'accepted', platformMessageIds: ids } : reject()
      } catch (error) { return { outcome: ids.length ? 'unknown' : outcome(error), platformMessageIds: ids } }
    },
    async keyboard(target: QqTarget, text: string, prompt: QqInteractionPrompt, signal?: AbortSignal,authorize?:()=>Promise<boolean>): Promise<QqReceipt> {
      try {
        validatePrompt(prompt)
        if (prompt.resolved || prompt.secret_fields?.length || !(prompt.options ?? []).some(option => option.token)) return reject()
        return postKeyboard(target, text, buildQqKeyboard(prompt), signal,authorize)
      } catch { return reject() }
    },
    async interaction(target: QqTarget, prompt: QqInteractionPrompt, signal?: AbortSignal,authorize?:()=>Promise<boolean>): Promise<QqButtonReceipt> {
      try { validatePrompt(prompt) } catch { return { ...reject(), delivery: 'none', buttonCount: 0 } }
      if (prompt.resolved) return { ...reject(), delivery: 'none', buttonCount: 0 }
      // 与Python统一出站一致：交互长任务用主动消息，不耗被动回复窗口。
      const active = { ...target, messageId: undefined }
      const presentation = { ...prompt, ...(prompt.options?.length ? { native_keyboard: true } : {}),
        ...(target.chatType === 'group' && prompt.secret_fields?.length ? { group_secret_blocked: true } : {}) }
      const text = formatQqInteractionFallback(presentation)
      if(authorize&&!await authorize())return{...reject(),delivery:'none',buttonCount:0}
      if (prompt.options?.length && !prompt.secret_fields?.length) {
        const native = await sender.keyboard(active, text, presentation, signal,authorize)
        if (native.outcome === 'accepted') return { ...native, delivery: 'native', buttonCount: prompt.options.filter(option => option.token).length }
        if (native.outcome === 'unknown') return { ...native, delivery: 'none', buttonCount: 0 }
      }
      if(authorize&&!await authorize())return{...reject(),delivery:'none',buttonCount:0}
      const fallback = await sender.text(active, text, signal,authorize)
      return { ...fallback, delivery: fallback.outcome === 'accepted' ? 'text' : 'none', buttonCount: 0 }
    },
    async linkButtons(target: QqTarget, message: string, buttons: readonly QqLinkButton[], signal?: AbortSignal): Promise<QqButtonReceipt> {
      const checked = validateLinkButtons(message, [...buttons])
      if ('error' in checked) return { ...reject(), delivery: 'none', buttonCount: 0 }
      const prepared = prepareQqLinkButtonMessage(checked.message, checked.buttons), active = { ...target, messageId: undefined }
      if (prepared.supported.length) {
        try {
          const wire = packButtons(prepared.supported.map((button, index) => ({ id: `gugu-link-${index + 1}`,
            render_data: { label: clip(button.label, 40), visited_label: clip(button.label, 40), style: 1 },
            action: { type: 0, permission: { type: 2 }, data: button.url, unsupport_tips: '当前客户端不支持打开链接' },
          })))
          const native = await postKeyboard(active, prepared.text, wire, signal)
          if (native.outcome === 'accepted') return { ...native, delivery: 'native', buttonCount: prepared.supported.length }
          if (native.outcome === 'unknown') return { ...native, delivery: 'none', buttonCount: 0 }
        } catch (error) { if (!(error instanceof RangeError)) return { outcome: 'unknown', platformMessageIds: [], delivery: 'none', buttonCount: 0 } }
      }
      const fallback = await sender.text(active, [prepared.text.trim(), ...prepared.supported.map(button => `· ${button.label}：${button.url}`)].filter(Boolean).join('\n'), signal)
      return { ...fallback, delivery: fallback.outcome === 'accepted' ? 'text' : 'none', buttonCount: 0 }
    },
    /** 只确认收到平台回调；授权/一次性action消费与Run恢复必须由Host另行执行。 */
    async ackInteraction(eventId: string, code: 0 | 3 = 0, signal?: AbortSignal): Promise<{ outcome: Outcome; acknowledged: boolean }> {
      if (!valid(eventId) || ![0, 3].includes(code)) return { outcome: 'rejected', acknowledged: false }
      try { await options.client.call('PUT', `/interactions/${eventId}`, { body: { code }, signal }); return { outcome: 'accepted', acknowledged: true } }
      catch (error) { return { outcome: outcome(error), acknowledged: false } }
    },
    /** fileInfo只能来自实际QQ媒体上传结果；此入口不生成或猜测平台文件凭证。 */
    async media(target: QqTarget, uploaded: { fileInfo: string; image: boolean; filename?: string }, signal?: AbortSignal,authorize?:()=>Promise<boolean>): Promise<QqReceipt> {
      if (!validTarget(target) || typeof uploaded.fileInfo !== 'string' || !uploaded.fileInfo || !uploaded.image && !uploaded.filename) return reject()
      try {
        const send = async (actual: QqTarget) => {
          const result = await options.client.call('POST', path(actual), { body: { msg_type: 7, media: { file_info: uploaded.fileInfo }, msg_seq: await sequence(actual),
            ...(actual.messageId ? { msg_id: actual.messageId } : {}), ...(!uploaded.image ? { content: uploaded.filename } : {}) }, signal,authorize })
          const id = messageId(result)
          if (!id) throw new QqApiError('message', 200, undefined, 'UNKNOWN')
          return id
        }
        const id = target.chatType === 'group' ? await withPassiveFallback(target, send) : await send(target)
        return { outcome: 'accepted', platformMessageIds: [id] }
      } catch (error) { return { outcome: outcome(error), platformMessageIds: [] } }
    },
    privateStream(target: QqTarget, signal?: AbortSignal, lifecycle: {authorize?:()=>Promise<boolean>;automaticFlush?:boolean;snapshot?:unknown;checkpoint?(snapshot:QqStreamSnapshot):Promise<void>} = {}) {
      if (!validTarget(target) || target.chatType !== 'c2c' || target.messageFormat === 'compat') throw new Error('QQ 私聊流身份或格式无效')
      let fullText = '', lastSentText = '', lastContent = '', streamId: string | null = null, msgSeq: number | null = null, index = 0
      let timer: ReturnType<typeof setTimeout> | undefined, tail: Promise<unknown> = Promise.resolve(), finished = false, failed = false, rejectedContent = false
      let finalTask: Promise<QqStreamReceipt> | undefined, flushInterval = 500,closed=false
      const binding=createHash('sha256').update(JSON.stringify([options.botId,target.id,target.chatType,target.messageId??null,target.messageFormat??'markdown'])).digest('hex')
      if(lifecycle.snapshot!==undefined){const value=parseQqStreamSnapshot(lifecycle.snapshot);if(value.binding!==binding)throw new Error('QQ 流式恢复目标不匹配');
        let confirmed=prepareQqText(options.sanitizeText(value.lastSentText));if(value.closed&&confirmed&&!confirmed.endsWith('\n'))confirmed+='\n'
        if(value.index>0&&confirmed!==value.lastSentContent)throw new Error('QQ 流式已确认前缀无效')
        ;({fullText,lastSentText,lastSentContent:lastContent,streamId,msgSeq,index,finished,failed,rejectedContent,flushInterval,closed}=value)}
      const snapshot=():QqStreamSnapshot=>parseQqStreamSnapshot({v:1,binding,fullText,lastSentText,lastSentContent:lastContent,streamId,msgSeq,index,finished,closed,failed,rejectedContent,flushInterval})
      const receipt = (result: Outcome, closed: boolean, mismatch = false): QqStreamReceipt => ({ outcome: result, platformMessageIds: streamId ? [streamId] : [], closed, ...(mismatch ? { reason: 'prefix-mismatch' as const } : {}) })
      function serial<T>(work: () => Promise<T>): Promise<T> { const result = tail.then(work); tail = result.catch(() => undefined); return result }
      async function frame(state: 1 | 10, override?: string): Promise<QqStreamReceipt> {
        let raw = state === 10 ? fullText : completeQqLines(fullText)
        let content: string
        try { content = override ?? prepareQqText(options.sanitizeText(raw)) }
        catch { failed = true; return receipt('unknown', false) }
        if (!content.trim() || state !== 10 && content === lastContent) return receipt('accepted', false)
        if (!content.startsWith(lastContent)) return receipt('unknown', false, true)
        if (state === 10 && !content.endsWith('\n')) content += '\n'
        if (failed && !streamId) return receipt('unknown', false)
        try {
          msgSeq ??= await sequence(target, true)
          await lifecycle.checkpoint?.(snapshot())
          const body: Record<string, unknown> = { input_mode: 'replace', input_state: state, content_type: 'markdown', content_raw: content, msg_seq: msgSeq, index,
            ...(target.messageId ? { msg_id: target.messageId, event_id: target.messageId } : {}), ...(streamId ? { stream_msg_id: streamId } : {}) }
          let response: Record<string, unknown>
          for (let retries = 0; ; retries++) {
            try { if(lifecycle.authorize&&!await lifecycle.authorize())return receipt('rejected',false);response = await options.client.call('POST', `/v2/users/${target.id}/stream_messages`, { body, signal,authorize:lifecycle.authorize }); break }
            catch (error) {
              const rateLimited = error instanceof QqApiError && (error.errorCode === 50002 || error.statusCode === 429)
              const serverRetry = error instanceof QqApiError && error.errorCode === 50001
              const knownStreamTransient = streamId !== null && error instanceof QqApiError &&
                (error.statusCode === undefined && error.retryable || error.statusCode !== undefined && (error.statusCode >= 500 || error.statusCode === 401))
              if (signal?.aborted || retries >= 3 || !rateLimited && !serverRetry && !knownStreamTransient) throw error
              if (rateLimited) flushInterval = Math.min(Math.max(flushInterval, 1000), 2000)
              const wait = rateLimited ? Math.min(1000 * 2 ** retries, 4000) : Math.min(500 * 2 ** retries, 2000)
              await (options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }) }))(wait, signal)
              // 完整body、index、stream_msg_id和msg_seq不变；绝不重新创建首帧。
            }
          }
          const acknowledged = messageId(response, true)
          if (!acknowledged || streamId && acknowledged !== streamId) throw new QqApiError('stream', 200, undefined, 'UNKNOWN')
          streamId = acknowledged; index++; lastContent = content;if(state===10)closed=true
          if (override === undefined) lastSentText = raw
          failed = false
          return receipt('accepted', state === 10)
        } catch (error) {
          failed = true
          rejectedContent = error instanceof QqApiError && error.outcome === 'FAILED_CONFIRMED' && [40007, 40034028].includes(error.errorCode ?? 0)
          const result=receipt(outcome(error), false, error instanceof QqApiError && error.errorCode === 40007)
          return index===0&&streamId===null&&error instanceof QqApiError&&error.outcome==='FAILED_CONFIRMED'?{...result,definitelyUnsent:true as const}:result
        }
      }
      const flush = () => serial(() => frame(1))
      return {
        push(delta: string): void {
          if (!delta || finished || failed) return
          fullText += delta
          if (!fullText.trim() || timer || lifecycle.automaticFlush===false) return
          timer = setTimeout(() => { timer = undefined; void flush() }, flushInterval)
        },
        flush,
        finish(finalText?: string, args: { allowRewrite?: boolean } = {}): Promise<QqStreamReceipt> {
          if (finalTask) return finalTask
          if(closed)return Promise.resolve(receipt('accepted',true))
          finished = true
          if (timer) { clearTimeout(timer); timer = undefined }
          finalTask = serial(async () => {
            let text = finalText || fullText
            if (fullText.startsWith(text) && !fullText.slice(text.length).trim()) text = fullText
            if (args.allowRewrite && options.normalizePrefix && lastSentText) {
              const normalized = options.normalizePrefix(options.sanitizeText(lastSentText))
              if (normalized && text.startsWith(normalized)) text = lastSentText + text.slice(normalized.length)
            }
            fullText = text
            if (!fullText.trim()) return receipt('rejected', false)
            const result = await frame(10)
            if (result.closed) return result
            if(result.outcome==='rejected'&&result.definitelyUnsent)return result
            // 本地前缀不匹配时仅关闭平台已确认内容；不得以关闭partial冒充完整交付。
            if ((result.reason === 'prefix-mismatch' || rejectedContent) && streamId && lastContent) {
              const close = await frame(10, lastContent)
              return receipt('unknown', close.closed, result.reason === 'prefix-mismatch')
            }
            return receipt('unknown', false)
          })
          return finalTask
        },
        state() { return { fullText, lastSentText, lastSentContent: lastContent, streamId, index, finished } },
        snapshot,
      }
    },
  }
  return sender
}
