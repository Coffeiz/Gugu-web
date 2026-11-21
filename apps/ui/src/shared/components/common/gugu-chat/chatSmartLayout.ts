import { escapeHtml } from '@/utils/escapeHtml'

type Fields = Record<string, unknown>
type Translate = (key: string, values?: Record<string, unknown>) => string
const objectKinds = new Set(['project', 'event', 'canvas', 'note', 'scheduled-task'])
const componentId = /^[a-z][a-z0-9_-]{0,39}$/i
const smartViewColors = new Set(['accent', 'info', 'success', 'warning', 'danger'])

function colorAttribute(value: unknown) {
  return typeof value === 'string' && smartViewColors.has(value) ? ` data-smart-color="${value}"` : ''
}

export const smartViewIcons = new Map([
  ['ri-apps-line', 'navigation.apps'],
  ['ri-trello-line', 'navigation.projects'],
  ['ri-calendar-event-line', 'navigation.calendar'],
  ['ri-time-line', 'navigation.schedules'],
  ['ri-list-unordered', 'action.list'],
  ['ri-sort-asc', 'action.sort'],
  ['ri-search-line', 'action.search'],
  ['ri-information-line', 'status.info'],
  ['ri-checkbox-circle-line', 'status.check-circle'],
  ['ri-error-warning-line', 'status.warning'],
])

function iconSlot(value: unknown) {
  return typeof value === 'string' && smartViewIcons.has(value)
    ? `<span class="chat-smart-icon" data-smart-icon="${value}" aria-hidden="true"></span>` : ''
}

function fields(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
  return value as Fields
}

function text(value: unknown, limit = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error()
  return escapeHtml(value.trim())
}

function number(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e9) throw new Error()
  return value
}

function id(value: unknown) {
  if (typeof value !== 'string' || !componentId.test(value)) throw new Error()
  return value
}

function sliderBinding(value: unknown) {
  if (typeof value === 'string' && componentId.test(value)) return ` data-smart-bind="${value}"`
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const { type, numerator, denominator } = value as Fields
  if (type !== 'ratio' || typeof numerator !== 'string' || !componentId.test(numerator) ||
    typeof denominator !== 'string' || !componentId.test(denominator)) return ''
  return ` data-smart-numerator="${numerator}" data-smart-denominator="${denominator}"`
}

function objectHref(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const action = value as Fields
  if (action.type !== 'open-object' || typeof action.kind !== 'string' || !objectKinds.has(action.kind) ||
    typeof action.id !== 'number' || !Number.isSafeInteger(action.id) || action.id <= 0) return null
  return `gugu://open-object/${action.kind}/${action.id}`
}

export function renderSmartLayout(layout: unknown, t: Translate): string {
  let count = 0
  const sliders = new Map<string, number>()
  const filters = new Set<string>()
  function renderGroup(children: unknown, columns: number, depth: number) {
    if (!Array.isArray(children) || !children.length || children.length > 24) throw new Error()
    const html = children.map(child => render(child, depth + 1)).join('')
    return html ? `<div class="chat-smart-layout" data-columns="${columns}">${html}</div>` : ''
  }

  function render(value: unknown, depth: number): string {
    const component = fields(value)
    if (depth > 5 || ++count > 80) throw new Error()
    switch (component.type) {
      case 'switch': {
        if (!Array.isArray(component.options) || component.options.length < 2 || component.options.length > 6) throw new Error()
        const options = component.options.map(fields)
        const keys = options.map(option => id(option.id))
        const active = component.default == null ? keys[0] : id(component.default)
        if (new Set(keys).size !== keys.length || !keys.includes(active)) throw new Error()
        const buttons = options.map((option, index) =>
          `<button type="button" data-smart-choice="${keys[index]}" aria-pressed="${keys[index] === active}">${text(option.label, 80)}</button>`).join('')
        const panels = options.map((option, index) =>
          `<div data-smart-panel="${keys[index]}"${keys[index] === active ? '' : ' hidden'}>${renderGroup(option.children, 1, depth)}</div>`).join('')
        return `<div class="chat-smart-switch"><div class="chat-smart-switch-options" role="group" aria-label="${text(component.label)}">${buttons}</div>${panels}</div>`
      }
      case 'stack':
      case 'section':
      case 'grid': {
        const columns = component.type === 'grid' ? number(component.columns ?? 2) : 1
        if (!Number.isInteger(columns) || columns < 1 || columns > 3) throw new Error()
        const group = renderGroup(component.children, columns, depth)
        if (!group) return ''
        return component.type === 'section'
          ? `<section class="chat-smart-section"><h4>${iconSlot(component.icon)}${text(component.title)}</h4>${group}</section>`
          : group
      }
      case 'text': {
        const variant = component.variant ?? 'body'
        if (variant !== 'title' && variant !== 'body' && variant !== 'hint') throw new Error()
        return `<div class="chat-smart-text is-${variant}"${colorAttribute(component.color)}>${iconSlot(component.icon)}<span>${text(component.text, 1000)}</span></div>`
      }
      case 'metric': {
        const binding = sliderBinding(component.bind)
        const initial = component.value ?? (binding ? 0 : undefined)
        const value = typeof initial === 'number' ? number(initial) : text(initial, 80)
        return `<div class="chat-smart-metric"${colorAttribute(component.color)}${binding}><span class="chat-smart-label">${iconSlot(component.icon)}${text(component.label)}</span><strong><span>${value}</span><span data-smart-unit>${component.unit == null ? '' : text(component.unit, 20)}</span></strong></div>`
      }
      case 'progress': {
        const binding = sliderBinding(component.bind)
        const current = number(component.value ?? (binding ? 0 : undefined)), max = number(component.max ?? 100)
        if (max <= 0 || current < 0 || current > max) throw new Error()
        const caption = text(component.label)
        return `<div class="chat-smart-progress-block"${colorAttribute(component.color)}${binding}><span class="chat-smart-label">${iconSlot(component.icon)}${caption}</span>
          <strong><span>${current}</span><span data-smart-unit>${component.unit == null ? ` / ${max}` : text(component.unit, 20)}</span></strong>
          <progress value="${current}" max="${max}" aria-label="${caption}"></progress></div>`
      }
      case 'slider': {
        const key = id(component.id)
        const min = number(component.min), max = number(component.max), step = number(component.step ?? 1), current = number(component.value)
        if (sliders.has(key) || min >= max || step <= 0 || step > max - min || current < min || current > max) throw new Error()
        sliders.set(key, current)
        const label = text(component.label)
        return `<label class="chat-smart-slider"${colorAttribute(component.color)}><span class="chat-smart-label">${iconSlot(component.icon)}${label}</span><strong data-smart-value>${current}</strong>
          <input type="range" class="progress-range" data-smart-slider="${key}" min="${min}" max="${max}" step="${step}" value="${current}" aria-label="${label}">
        </label>`
      }
      case 'button': {
        const href = objectHref(component.action)
        return href ? `<a class="chat-smart-button" href="${href}">${text(component.label)}</a>` : ''
      }
      case 'list': {
        if (!Array.isArray(component.items) || component.items.length > 30) throw new Error()
        const filter = component.filter == null ? null : fields(component.filter)
        const source = filter ? id(filter.slider) : null
        if (filter && filter.operator !== 'lte' && filter.operator !== 'gte') throw new Error()
        if (source) filters.add(source)
        const items = component.items.map(value => {
          const item = fields(value)
          const label = text(item.label)
          const detail = item.detail == null ? '' : `<span class="chat-smart-list-detail">${text(item.detail, 240)}</span>`
          const href = objectHref(item.action)
          const tag = href ? 'a' : 'div'
          return `<li${source ? ` data-smart-compare="${number(item.value)}"` : ''}><${tag} class="chat-smart-row"${href ? ` href="${href}"` : ''}><strong class="chat-smart-label">${iconSlot(item.icon)}${label}</strong>${detail}</${tag}></li>`
        })
        return `<div${source ? ` data-smart-filter="${source}" data-smart-operator="${filter?.operator}"` : ''}>
          <ul class="chat-smart-rows">${items.join('')}</ul>
          <div class="chat-smart-view-notice" data-smart-empty${items.length ? ' hidden' : ''}>${t('empty')}</div>
        </div>`
      }
      default: return ''
    }
  }
  const html = render(layout, 0)
  if (!html || [...filters].some(source => !sliders.has(source))) throw new Error()
  return `<section class="chat-smart-view chat-smart-layout-view">${html}</section>`
}

export function selectSmartViewOption(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  const button = target.closest<HTMLButtonElement>('.chat-smart-layout-view button[data-smart-choice]')
  const group = button?.closest('.chat-smart-switch')
  if (!button || !group) return false
  for (const option of group.querySelectorAll<HTMLButtonElement>(':scope > .chat-smart-switch-options > button')) {
    option.setAttribute('aria-pressed', String(option === button))
  }
  for (const panel of group.querySelectorAll<HTMLElement>(':scope > [data-smart-panel]')) {
    panel.hidden = panel.dataset.smartPanel !== button.dataset.smartChoice
  }
  return true
}

function readRatio(view: Element, numerator?: string, denominator?: string) {
  if (!numerator || !denominator || !componentId.test(numerator) || !componentId.test(denominator)) return undefined
  const top = view.querySelector<HTMLInputElement>(`input[type="range"][data-smart-slider="${numerator}"]`)?.valueAsNumber
  const bottom = view.querySelector<HTMLInputElement>(`input[type="range"][data-smart-slider="${denominator}"]`)?.valueAsNumber
  if (top === undefined || bottom === undefined) return undefined
  const percentage = top / bottom * 100
  return Number.isFinite(percentage) ? Number(percentage.toFixed(2)) : null
}

export function updateSmartViewSlider(input: HTMLInputElement) {
  const view = input.closest('.chat-smart-layout-view')
  const key = input.dataset.smartSlider
  const value = input.valueAsNumber
  if (!view || !key || !componentId.test(key) || input.type !== 'range' || !Number.isFinite(value)) return
  const min = Number(input.min), max = Number(input.max)
  if (max > min) input.style.setProperty('--progress-position', `${(value - min) / (max - min) * 100}%`)
  const output = input.closest('.chat-smart-slider')?.querySelector('[data-smart-value]')
  if (output) output.textContent = String(value)
  for (const target of view.querySelectorAll<HTMLElement>(
    `[data-smart-bind="${key}"], [data-smart-numerator="${key}"], [data-smart-denominator="${key}"]`,
  )) {
    const { smartBind, smartNumerator, smartDenominator } = target.dataset
    const current = smartBind ? value : readRatio(view, smartNumerator, smartDenominator)
    if (current === undefined) continue
    const progress = target.querySelector<HTMLProgressElement>(':scope > progress')
    if (progress) progress.value = Math.min(progress.max, Math.max(0, current ?? 0))
    const display = target.querySelector(':scope > strong > span:first-child')
    if (display) display.textContent = current === null ? '—' : String(smartBind ? progress?.value ?? current : current)
    const unit = target.querySelector<HTMLElement>(':scope > strong > [data-smart-unit]')
    if (unit) unit.hidden = current === null
  }
  for (const list of view.querySelectorAll<HTMLElement>(`[data-smart-filter="${key}"]`)) {
    let visible = 0
    for (const row of list.querySelectorAll<HTMLElement>(':scope > ul > li[data-smart-compare]')) {
      const item = Number(row.dataset.smartCompare)
      row.hidden = list.dataset.smartOperator === 'gte' ? item < value : item > value
      if (!row.hidden) visible++
    }
    const empty = list.querySelector<HTMLElement>(':scope > [data-smart-empty]')
    if (empty) empty.hidden = visible > 0
  }
}
