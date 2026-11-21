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

export function renderSmartView(source: string) {
  const t = (key: string, values: Record<string, unknown> = {}) => escapeHtml(i18n.global.t(`smartView.${key}`, values))
  const unavailable = `<p class="chat-smart-view-notice">${t('unavailable')}</p>`
  if (source.length > 24_000) return unavailable
  let view: Fields
  try { view = object(JSON.parse(source)) } catch { return unavailable }
  if (view.version === 1 && view.layout !== undefined) {
    try { return renderSmartLayout(view.layout, t) } catch { return unavailable }
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
