import { i18n } from '@/i18n'
import { escapeHtml } from '@/utils/escapeHtml'
import { renderSmartLayout } from './chatSmartLayout'

type Fields = Record<string, unknown>
type ViewRow = { id: number; name: string; date: string; detail: string; status?: string; progress?: number }

function object(value: unknown): Fields {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {}
}

function text(value: unknown, limit: number) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function date(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value) ? value : ''
}

function time(value: unknown) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : ''
}

/** 只移除出现在数组内、紧邻下一段之前的不匹配花括号。 */
function repairSectionClosures(source: string) {
  const stack: string[] = []
  return source.replace(/"(?:\\.|[^"\\])*"|[{}\[\]]/gu, (token: string, offset: number) => {
    if (token === '{' || token === '[') stack.push(token)
    if (token === '}' && stack.at(-1) === '[' && source.slice(offset - 2, offset) === ']}'
      && /^\s*,\s*\{\s*"type"\s*:\s*"section"/u.test(source.slice(offset + 1))) return ''
    if (token === '}' || token === ']') stack.pop()
    return token
  })
}

/** 只补齐布局容器的边界，不补写尚未完成的叶子组件。 */
function completedLayout(source: string): { view: Fields; complete: boolean } | undefined {
  const stack: { close: string; start: number }[] = []
  const broken: { start: number; end: number }[] = []
  let end = 0
  let suffix = ''
  for (const match of source.matchAll(/"(?:\\.|[^"\\])*"|["{}\[\]]/gu)) {
    const token = match[0]
    if (token === '"') break
    if (token === '{' || token === '[') {
      stack.push({ close: token === '{' ? '}' : ']', start: match.index })
      continue
    }
    if (token !== '}' && token !== ']') continue
    const frame = stack.pop()
    if (frame?.close !== token) break
    const parent = stack.at(-1)
    const itemEnd = match.index + 1
    if (token === '}' && parent?.close === ']'
      && /"children"\s*:\s*$/u.test(source.slice(Math.max(0, parent.start - 100), parent.start))
      && (broken.at(-1)?.start ?? -1) < frame.start) {
      try { JSON.parse(source.slice(frame.start, itemEnd)) }
      catch { broken.push({ start: frame.start, end: itemEnd }) }
    }
    if (token !== '}' || !stack.every(({ close, start }, index) => index === 0
      || (close === ']' ? /"children"\s*:\s*$/u.test(source.slice(Math.max(0, start - 100), start))
        : /^\{\s*"type"\s*:\s*"(?:stack|section|grid)"/u.test(source.slice(start))))) continue
    end = match.index + 1
    suffix = stack.map(frame => frame.close).reverse().join('')
  }
  if (!end) return undefined
  let prefix = source.slice(0, end)
  for (const item of broken.reverse()) {
    if (item.end <= end) prefix = prefix.slice(0, item.start) + 'null' + prefix.slice(item.end)
  }
  try { return { view: object(JSON.parse(prefix + suffix)), complete: !suffix && !source.slice(end).trim() } } catch { return undefined }
}

export function renderSmartView(source: string, unclosedFence = false) {
  const t = (key: string, values: Record<string, unknown> = {}) => escapeHtml(i18n.global.t(`smartView.${key}`, values))
  const unavailable = `<p class="chat-smart-view-notice">${t('unavailable')}</p>`
  if (source.length > 24_000) return unavailable
  let view: Fields
  try {
    view = object(JSON.parse(source))
  } catch {
    // 兼容模型漏写 detail 的起始引号。完整字符串原样保留，修复后仍走 JSON 和组件校验。
    let repaired = source.replace(/("detail"\s*:\s*)(\p{Script=Han}[^"\\\r\n{}\[\],]{0,239})"(?=\s*[,}])|"(?:\\.|[^"\\])*"/gu,
      (match, key: string | undefined, detail: string | undefined) =>
        key && detail ? key + JSON.stringify(detail) : match)
    // detail 和 text 是纯显示文本。保留合法转义，仅补齐正文内未转义的双引号。
    repaired = repaired.replace(/("(?:detail|text)"\s*:\s*")((?:\\.|[^"\\\r\n]|"(?!\s*(?:\}|,\s*"[^"\r\n]+"\s*:))){0,1000})"(?=\s*(?:\}|,\s*"[^"\r\n]+"\s*:))|"(?:\\.|[^"\\])*"/gu,
      (match, key: string | undefined, detail: string | undefined) =>
        key && detail ? key + detail.replace(/\\.|"/gu, token => token === '"' ? '\\"' : token) + '"' : match)
    // 模型偶尔在 section 同级节点前提前关闭外层 children 和布局对象。
    // 跳过字符串内容，只尝试删除一处多余的闭合符，随后仍需通过完整校验。
    let removed = false
    if (/^\s*\{\s*"version"\s*:\s*1\s*,\s*"layout"\s*:/u.test(repaired)) {
      const balanced = repairSectionClosures(repaired)
      repaired = balanced !== repaired ? balanced : repaired.replace(/"(?:\\.|[^"\\])*"|\]\}(\]\})(?=\s*,\s*\{\s*"type"\s*:\s*"section")/gu,
        (match, extra: string | undefined) => {
          if (!extra || removed) return match
          removed = true
          return match.slice(0, -extra.length)
        })
    }
    // 历史消息可能在围栏内截断，保留之前已完整输出的正文。
    try { view = object(JSON.parse(repaired)) } catch {
      const recovered = completedLayout(repaired)
      const partial = recovered?.view
      if (partial?.version !== 1 || partial.layout === undefined) return unclosedFence ? '' : unavailable
      try {
        const html = renderSmartLayout(partial.layout, t, partial.state, true, unclosedFence)
        return html + (unclosedFence || recovered?.complete ? '' : unavailable)
      } catch { return unclosedFence ? '' : unavailable }
    }
  }
  if (view.version === 1 && view.layout !== undefined) {
    try { return renderSmartLayout(view.layout, t, view.state, true, unclosedFence) } catch { return unavailable }
  }
  const project = view.template === 'project-overview'
  if (!project && view.template !== 'today-agenda') return unavailable
  const asOf = date(view.date)
  if (!asOf || !Array.isArray(view.items) || view.items.length > 30) return unavailable
  const rows: ViewRow[] = []
  for (const item of view.items) {
    const row = object(item)
    const { id, progress } = row
    const name = text(row.name, 160)
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || !name) return unavailable
    if (project) {
      const due = date(row.due_date)
      if ((row.due_date != null && !due) ||
        (progress != null && (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100)))
        return unavailable
      const status = row.completed === true ? 'completed' : due && due < asOf ? 'overdue' : due === asOf ? 'today' : undefined
      rows.push({ id, name, date: due, detail: text(row.stage, 80), status,
        progress: typeof progress === 'number' ? Math.round(progress) : undefined })
    } else {
      const start = time(row.start_time)
      const end = time(row.end_time)
      if ((row.start_time != null && !start) || (row.end_time != null && (!end || !start || end < start))) return unavailable
      rows.push({ id, name, date: row.all_day === true ? '' : start, detail: end && row.all_day !== true ? end : '',
        status: row.all_day === true ? 'allDay' : undefined })
    }
  }
  rows.sort((a, b) => (a.date || (a.status === 'allDay' ? '0' : '~')).localeCompare(b.date || (b.status === 'allDay' ? '0' : '~')))
  const summary = text(view.summary, 240)
  const overdue = rows.filter(row => row.status === 'overdue').length
  const count = t(project ? 'projects' : 'events', { count: rows.length })
  const blocks = rows.map(row => {
    const status = row.status ? `<span class="chat-smart-status is-${row.status}">${t(row.status)}</span>` : ''
    const when = row.date ? `<span class="chat-smart-when">${row.date}${!project && row.detail ? `–${row.detail}` : ''}</span>` : ''
    const detail = project && row.detail ? `<span class="chat-smart-detail">${escapeHtml(row.detail)}</span>` : ''
    const progress = row.progress === undefined ? '' : `<span class="chat-smart-progress">
      <progress value="${row.progress}" max="100" aria-label="${t('progress')}"></progress><span>${row.progress}%</span>
    </span>`
    return `<li><a class="chat-smart-row" href="gugu://open-object/${project ? 'project' : 'event'}/${row.id}">
      <strong>${escapeHtml(row.name)}</strong><span class="chat-smart-fields">${status}${detail}${progress}${when}</span>
    </a></li>`
  })
  return `<section class="chat-smart-view">
    <header class="chat-smart-heading"><strong>${t(project ? 'projectOverview' : 'todayAgenda')}</strong><span>${asOf}</span></header>
    ${summary ? `<div class="chat-smart-summary">${escapeHtml(summary)}</div>` : ''}
    <div class="chat-smart-metrics"><strong>${count}</strong>${overdue ? `<span>${t('overdueCount', { count: overdue })}</span>` : ''}</div>
    ${blocks.length ? `<ul class="chat-smart-rows">${blocks.join('')}</ul>` : `<div class="chat-smart-view-notice">${t('empty')}</div>`}
  </section>`
}
