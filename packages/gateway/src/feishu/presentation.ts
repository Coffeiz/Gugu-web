import { buildFeishuCardElements } from './sender.js'

type Element = Record<string, unknown>
export type FeishuToolEvent = { type: 'tool_call' | 'tool_done'; toolCallId?: string; name?: string; label?: string; status?: string; input?: unknown; result?: unknown }
/** 只允许可信Host为私聊打开详情；脱敏必须沿用正式出站策略。 */
export type FeishuToolSummaryPolicy = { chatType: 'group'; includeDetails?: false; sanitize(text: string): string }
  | { chatType: 'p2p'; includeDetails?: boolean; sanitize(text: string): string }
type TextBlock = { kind: 'text'; id: string; text: string }
type ToolBlock = { kind: 'tools'; events: FeishuToolEvent[] }
type Block = TextBlock | ToolBlock | { kind: 'image'; key: string; source: string }
const clip = (text: string, size: number) => [...text].slice(0, size).join('')
function count(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + count(item), 0)
  if (value && typeof value === 'object') return Number('tag' in value) + Object.values(value).reduce<number>((sum, item) => sum + count(item), 0)
  return 0
}

/** 同一卡片里的正文、图片与工具组；顺序由唯一流消费者维护。 */
export class FeishuPresentation {
  private blocks: Block[] = []
  private nextId = 1
  private active: TextBlock | null = null
  private locations = new Map<string, { block: ToolBlock; index: number }>()
  private visible = 0
  private omitted = 0
  readonly embeddedSources: string[] = []
  used = false
  constructor(private policy?: FeishuToolSummaryPolicy) {
    if (policy?.chatType === 'group') this.policy = { ...policy, includeDetails: false }
  }
  snapshot(): unknown { return { v: 1, blocks: this.blocks, nextId: this.nextId, activeId: this.active?.id ?? null,
    visible: this.visible, omitted: this.omitted, embeddedSources: this.embeddedSources, used: this.used } }
  static restore(raw: unknown, policy?: FeishuToolSummaryPolicy): FeishuPresentation {
    const fail = (): never => { throw new Error('飞书呈现状态无效') }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail()
    const value = raw as Record<string, unknown>
    if (value.v !== 1 || !Array.isArray(value.blocks) || value.blocks.length > 4096 || typeof value.used !== 'boolean'
      || !Array.isArray(value.embeddedSources) || !value.embeddedSources.every(item => typeof item === 'string')
      || ![value.nextId, value.visible, value.omitted].every(item => Number.isSafeInteger(item) && Number(item) >= 0)
      || Number(value.nextId) < 1 || Number(value.visible) > 24 || value.activeId !== null && typeof value.activeId !== 'string') return fail()
    const copy = new FeishuPresentation(policy), ids = new Set<string>()
    for (const rawBlock of value.blocks) {
      if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) return fail()
      const block = rawBlock as Record<string, unknown>
      if (block.kind === 'text') {
        if (typeof block.id !== 'string' || !/^markdown_[1-9]\d*$/.test(block.id) || ids.has(block.id) || typeof block.text !== 'string') return fail()
        ids.add(block.id)
      } else if (block.kind === 'image') { if (typeof block.key !== 'string' || !block.key || typeof block.source !== 'string') return fail() }
      else if (block.kind === 'tools') {
        if (!Array.isArray(block.events) || block.events.length > 24 || block.events.some(event => !event || typeof event !== 'object' || !['tool_call', 'tool_done'].includes(event.type)
          || ['toolCallId', 'name', 'label', 'status'].some(field => event[field] !== undefined && typeof event[field] !== 'string'))) return fail()
      } else return fail()
    }
    copy.blocks = structuredClone(value.blocks) as Block[]; copy.nextId = Number(value.nextId); copy.visible = Number(value.visible); copy.omitted = Number(value.omitted); copy.used = value.used
    copy.embeddedSources.push(...value.embeddedSources as string[])
    copy.active = value.activeId === null ? null : copy.blocks.find((block): block is TextBlock => block.kind === 'text' && block.id === value.activeId) ?? null
    if (value.activeId !== null && !copy.active) return fail()
    for (const block of copy.blocks) if (block.kind === 'tools') block.events.forEach((event, index) => { if (event.toolCallId) copy.locations.set(event.toolCallId, { block, index }) })
    return copy
  }
  copy(): FeishuPresentation {
    const copy = new FeishuPresentation(this.policy)
    copy.blocks = structuredClone(this.blocks); copy.nextId = this.nextId; copy.visible = this.visible; copy.omitted = this.omitted; copy.used = this.used
    copy.active = this.active ? copy.blocks.find((block): block is TextBlock => block.kind === 'text' && block.id === this.active!.id) ?? null : null
    copy.embeddedSources.push(...this.embeddedSources)
    for (const block of copy.blocks) if (block.kind === 'tools') block.events.forEach((event, index) => { if (event.toolCallId) copy.locations.set(event.toolCallId, { block, index }) })
    return copy
  }
  get activeId(): string { return this.active?.id ?? 'markdown_1' }
  get activeText(): string { return this.active?.text ?? '' }
  append(text: string): boolean {
    if (!text) return false
    const created = !this.active
    if (!this.active) { this.active = { kind: 'text', id: `markdown_${this.nextId++}`, text: '' }; this.blocks.push(this.active) }
    this.active.text += text
    return created
  }
  endRound(): void { if (this.policy) this.active = null }
  tool(event: FeishuToolEvent): boolean {
    if (!this.policy || !this.policy.includeDetails && event.type === 'tool_call') return false
    this.used = true
    const previous = event.toolCallId ? this.locations.get(event.toolCallId) : undefined
    if (previous) { previous.block.events[previous.index] = { ...previous.block.events[previous.index], ...event }; return true }
    this.active = null
    if (this.visible >= 24) { this.omitted++; return true }
    const tail = this.blocks.at(-1)
    const block: ToolBlock = !this.policy.includeDetails && tail?.kind === 'tools' ? tail : { kind: 'tools', events: [] }
    if (tail !== block) this.blocks.push(block)
    if (event.toolCallId) this.locations.set(event.toolCallId, { block, index: block.events.length })
    block.events.push({ ...event }); this.visible++
    return true
  }
  replace(source: string, key: string): boolean {
    if (!this.active || !source || !key) return false
    const index = this.active.text.lastIndexOf(source)
    if (index < 0) return false
    const before = this.active.text.slice(0, index), after = this.active.text.slice(index + source.length)
    const original = this.active, position = this.blocks.indexOf(original)
    const next: TextBlock = { kind: 'text', id: `markdown_${this.nextId++}`, text: after }
    this.blocks.splice(position, 1, ...(before ? [{ ...original, text: before }] : []), { kind: 'image', key, source }, next)
    this.active = next; this.used = true; this.embeddedSources.push(source)
    return true
  }
  finish(text: string, cancelled: boolean): void {
    if (cancelled) {
      for (const block of this.blocks) if (block.kind === 'tools') for (const event of block.events)
        if (event.type === 'tool_call' && ['queued', 'running'].includes(event.status ?? '')) event.status = 'cancelled'
      return
    }
    if (!this.policy && this.embeddedSources.length) {
      const images = this.blocks.filter((block): block is Extract<Block, { kind: 'image' }> => block.kind === 'image')
      this.blocks = []; this.active = null; this.embeddedSources.splice(0); this.nextId = 1
      let cursor = 0
      for (const image of images) {
        const position = text.indexOf(image.source, cursor)
        if (position < 0) continue
        this.append(text.slice(cursor, position)); this.active = null
        this.blocks.push(image); this.embeddedSources.push(image.source); cursor = position + image.source.length
      }
      this.append(text.slice(cursor))
      return
    }
    const last = this.embeddedSources.at(-1)
    const tail = last ? text.includes(last) ? text.slice(text.lastIndexOf(last) + last.length) : this.activeText : text
    if (this.active) this.active.text = tail
    else if (tail) this.append(tail)
  }
  elements(): Element[] {
    const elements: Element[] = []
    for (const block of this.blocks) {
      if (block.kind === 'text' && (block.text || block === this.active)) {
        let candidates = block === this.active ? [{ tag: 'markdown', content: (block.text || ' ').replace(/^#{1,6}\s+(.+)$/gm, '**$1**'), element_id: block.id }]
          : buildFeishuCardElements(block.text).map(value => { const copy = { ...value }; delete copy.element_id; return copy })
        if (count(elements) + count(candidates) > 180) candidates = [{ tag: 'markdown', content: block.text }]
        elements.push(...candidates)
      } else if (block.kind === 'image') elements.push({ tag: 'img', img_key: block.key, mode: 'fit_horizontal' })
      else if (block.kind === 'tools') {
        const title = this.policy?.includeDetails && block.events.length === 1 ? `🛠 ${this.label(block.events[0]!)}` : `🛠 工具摘要 (${block.events.length})`
        const panel = { tag: 'collapsible_panel', expanded: false, background_color: 'grey', border: { color: 'grey', corner_radius: '8px' },
          header: { title: { tag: 'plain_text', content: title } }, padding: '8px 12px',
          elements: block.events.map(event => ({ tag: 'markdown', content: this.entry(event) })) }
        if (count(elements) + count(panel) <= 180) elements.push(panel)
      }
    }
    if (this.omitted) { const notice = { tag: 'markdown', content: `_另有 ${this.omitted} 个工具调用摘要未展示。_` }; if (count(elements) < 180) elements.push(notice); else elements.splice(-1, 1, notice) }
    return elements.length ? elements : [{ tag: 'markdown', content: ' ' }]
  }
  plainText(): string {
    return this.elements().flatMap(element => element.tag === 'markdown' ? [String(element.content ?? '')]
      : element.tag === 'collapsible_panel' && Array.isArray(element.elements) ? element.elements.map(child => child && typeof child === 'object' ? String((child as Element).content ?? '') : '') : []).filter(Boolean).join('\n\n')
  }
  private label(event: FeishuToolEvent): string { return clip(this.policy!.sanitize((event.label || event.name || '工具').trim().replace(/\s+/g, ' ')), 80) }
  private detail(value: unknown): string {
    if (typeof value === 'string') { try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === 'object') value = parsed } catch { /* 普通文本结果 */ } }
    const language = typeof value === 'string' ? 'text' : 'json'
    let body: string
    try { body = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null' } catch { body = '[无法展示]' }
    body = clip(body, 1200)
    return '```' + language + '\n' + this.policy!.sanitize(body.replaceAll('```', '` ` `')) + '\n```'
  }
  private entry(event: FeishuToolEvent): string {
    const status = event.status ?? '', label = this.label(event), done = event.type === 'tool_done'
    if (!this.policy!.includeDetails) {
      if (event.name === 'send_file') {
        let result = event.result
        if (typeof result === 'string') { try { result = JSON.parse(result) } catch { result = null } }
        const delivery = result && typeof result === 'object' ? (result as Element).delivery_status : null
        if (delivery === 'sent') return '✅ 平台已接受文件发送'
        if (delivery === 'unknown') return '⚠️ 文件发送结果未确认，请先检查是否收到'
        if (delivery === 'failed') return '⚠️ 文件未能发送，请检查原因后重新发起请求'
        if (['success', 'ok'].includes(status)) return '📎 文件已准备，将在回复结束后尝试发送'
      }
      return ['success', 'ok'].includes(status) ? `✅ ${label}完成` : status === 'waiting' ? `⏸️ ${label}：任务已暂停，等待确认` : `⚠️ ${label}未完成`
    }
    const [icon, state] = done ? ({ success: ['✅', '已完成'], ok: ['✅', '已完成'], waiting: ['⏸️', '等待确认'], cancelled: ['⏹️', '已停止'] }[status] ?? ['⚠️', '未完成'])
      : ({ queued: ['⏳', '排队中'], running: ['⏳', '执行中'], invalid: ['⚠️', '未执行'], cancelled: ['⏹️', '已停止'] }[status] ?? ['⏳', '执行中'])
    const parts = [`**${icon} ${label} · ${state}**`, `**状态**：${state}`]
    if ('input' in event) parts.push('**输入**', this.detail(event.input))
    if (event.result != null) parts.push('**结果**', this.detail(event.result))
    return clip(this.policy!.sanitize(parts.join('\n\n')), 2400)
  }
}
