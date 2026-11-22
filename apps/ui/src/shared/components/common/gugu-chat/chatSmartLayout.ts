import { escapeHtml } from '@/utils/escapeHtml'
import { refreshSmartRanking } from './chatSmartInteractive'

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

function bindingAttributes(value: unknown) {
  if (typeof value === 'string' && componentId.test(value)) return ` data-smart-bind="${value}"`
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const { type, source, numerator, denominator } = value as Fields
  if ((type === 'count' || type === 'sum') && typeof source === 'string' && componentId.test(source)) {
    return ` data-smart-aggregate="${source}" data-smart-operation="${type}"`
  }
  if (type !== 'ratio' || typeof numerator !== 'string' || !componentId.test(numerator) ||
    typeof denominator !== 'string' || !componentId.test(denominator)) return ''
  return ` data-smart-numerator="${numerator}" data-smart-denominator="${denominator}"`
}

function actionHref(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const action = value as Fields
  if (action.type === 'open-url') {
    if (typeof action.url !== 'string' || action.url.length > 4096 || !/^https?:\/\//i.test(action.url)) return null
    try {
      const url = new URL(action.url)
      return !url.username && !url.password ? escapeHtml(url.href) : null
    } catch {
      return null
    }
  }
  if (action.type !== 'open-object' || typeof action.kind !== 'string' || !objectKinds.has(action.kind) ||
    typeof action.id !== 'number' || !Number.isSafeInteger(action.id) || action.id <= 0) return null
  return `gugu://open-object/${action.kind}/${action.id}`
}

export function renderSmartLayout(layout: unknown, t: Translate, initialState?: unknown): string {
  let count = 0
  const entries = initialState == null ? [] : Object.entries(fields(initialState))
  if (entries.length > 16) throw new Error()
  const state = new Map(entries.map(([key, value]) => {
    if (typeof value !== 'boolean' && (typeof value !== 'string' || value.length > 80)) throw new Error()
    return [id(key), value] as const
  }))
  function condition(value: unknown) {
    if (value == null) return ''
    const { state: name, equals } = fields(value)
    const key = id(name)
    if (!state.has(key) || typeof state.get(key) !== typeof equals
      || (typeof equals === 'string' && equals.length > 80)) throw new Error()
    return ` data-smart-when="${key}" data-smart-equals="${escapeHtml(JSON.stringify(equals))}"${state.get(key) !== equals ? ' hidden' : ''}`
  }
  const controlIds = new Set<string>()
  const sliders = new Set<string>()
  const filters = new Set<string>()
  const numericInputs = new Set<string>()
  const chartFilters = new Set<string>()
  const rankingWeights = new Set<string>()
  function registerControl(value: unknown) {
    const key = id(value)
    if (controlIds.has(key)) throw new Error()
    controlIds.add(key)
    return key
  }
  function renderGroup(children: unknown, columns: number, depth: number) {
    if (!Array.isArray(children) || !children.length || children.length > 24) throw new Error()
    const html = children.map(child => render(child, depth + 1)).join('')
    return html ? `<div class="chat-smart-layout" data-columns="${columns}">${html}</div>` : ''
  }

  function render(value: unknown, depth: number): string {
    const component = fields(value)
    if (depth > 6 || ++count > 80) throw new Error()
    const html = renderComponent(component, depth)
    return html && component.when != null ? `<div${condition(component.when)}>${html}</div>` : html
  }

  function renderComponent(component: Fields, depth: number): string {
    switch (component.type) {
      case 'split': {
        const ratio = component.ratio ?? '50:50'
        if (ratio !== '50:50' && ratio !== '60:40' && ratio !== '40:60') throw new Error()
        const primary = renderGroup(component.primary, 1, depth)
        const secondary = renderGroup(component.secondary, 1, depth)
        const fixed = component.fixed == null ? null : fields(component.fixed)
        if (fixed && ((fixed.side !== 'primary' && fixed.side !== 'secondary')
          || (fixed.width !== 'rail' && fixed.width !== 'compact'))) throw new Error()
        const fixedAttrs = fixed ? ` data-smart-fixed="${fixed.side}" data-smart-width="${fixed.width}"` : ''
        return `<div class="chat-smart-split"><div class="chat-smart-split-track" data-smart-ratio="${ratio}"${fixedAttrs}><div>${primary}</div><div${condition(component.secondaryWhen)}>${secondary}</div></div></div>`
      }
      case 'panel': {
        const height = component.height ?? 'auto'
        if (height !== 'auto' && height !== 'compact' && height !== 'regular' && height !== 'tall') throw new Error()
        const label = component.label == null || component.label === '' ? '' : text(component.label)
        const labelAttrs = label ? ` aria-label="${label}"` : ''
        const title = label ? `<h4>${iconSlot(component.icon)}${label}</h4>` : ''
        const header = component.header == null ? '' : renderGroup(component.header, 1, depth)
        const body = renderGroup(component.children, 1, depth)
        const footer = component.footer == null ? '' : renderGroup(component.footer, 1, depth)
        const scrollAttrs = height === 'auto' ? '' : ` tabindex="0"${label ? ` role="region"${labelAttrs}` : ''}`
        return `<section class="chat-smart-panel" data-smart-height="${height}"${labelAttrs}>
          ${title || header ? `<header>${title}${header}</header>` : ''}
          <div class="chat-smart-panel-body"${scrollAttrs}>${body}</div>
          ${footer ? `<footer>${footer}</footer>` : ''}
        </section>`
      }
      case 'toolbar': {
        const orientation = component.orientation ?? 'horizontal'
        if (orientation !== 'horizontal' && orientation !== 'vertical') throw new Error()
        if (!Array.isArray(component.children) || !component.children.length || component.children.length > 24) throw new Error()
        const children = component.children.map(child => render(child, depth + 1)).join('')
        const groupAttrs = component.label == null ? '' : ` role="group" aria-label="${text(component.label)}"`
        return children ? `<div class="chat-smart-toolbar" data-smart-orientation="${orientation}"${groupAttrs}>${children}</div>` : ''
      }
      case 'timeline': {
        if (!Array.isArray(component.items) || !component.items.length || component.items.length > 30) throw new Error()
        const items = component.items.map(value => {
          const item = fields(value)
          const status = item.status
          const state = status === 'done' || status === 'current' || status === 'planned' ? status : ''
          const href = actionHref(item.action)
          const title = `${iconSlot(item.icon)}${text(item.label)}`
          const detail = item.detail == null ? '' : `<span class="chat-smart-list-detail">${text(item.detail, 240)}</span>`
          return `<li data-smart-time-state="${state}"><span class="chat-smart-list-detail">${text(item.when, 80)}${state ? ` · ${t(`timeline_${state}`)}` : ''}</span>
            <strong class="chat-smart-label">${href ? `<a href="${href}">${title}</a>` : title}</strong>${detail}</li>`
        }).join('')
        return `<section class="chat-smart-section chat-smart-timeline"><h4>${text(component.label)}</h4><ol>${items}</ol></section>`
      }
      case 'ranking': {
        if (!Array.isArray(component.criteria) || component.criteria.length < 2 || component.criteria.length > 8
          || !Array.isArray(component.items) || !component.items.length || component.items.length > 12) throw new Error()
        const criteria = component.criteria.map(fields)
        const keys = criteria.map(criterion => id(criterion.id))
        const weights = criteria.map(criterion => id(criterion.weight))
        if (new Set(keys).size !== keys.length || new Set(weights).size !== weights.length) throw new Error()
        for (const weight of weights) rankingWeights.add(weight)
        const labels = criteria.map(criterion => text(criterion.label, 80))
        const items = component.items.map((value, index) => {
          const item = fields(value)
          const scores = fields(item.scores)
          const values = keys.map(key => number(scores[key]))
          if (values.some(score => score < 0 || score > 10)) throw new Error()
          const title = text(item.label)
          const breakdown = values.map((score, position) => `${labels[position]} ${score}`).join(' · ')
          return `<li data-smart-scores="${values.join(' ')}" data-smart-order="${index}">
            <div class="chat-smart-ranking-label"><strong>${title}</strong><span data-smart-score>—</span></div>
            <progress value="0" max="10" aria-label="${title}"></progress><span class="chat-smart-list-detail">${breakdown}</span></li>`
        }).join('')
        return `<section class="chat-smart-section chat-smart-ranking" data-smart-ranking="${weights.join(' ')}"><h4>${text(component.label)}</h4><ol>${items}</ol>
          <button class="chat-smart-local-button" type="button" data-smart-reset-weights>${t('resetWeights')}</button></section>`
      }
      case 'wizard': {
        if (!Array.isArray(component.steps) || component.steps.length < 2 || component.steps.length > 6) throw new Error()
        const steps = component.steps.map(fields)
        const keys = steps.map(step => id(step.id))
        if (new Set(keys).size !== keys.length) throw new Error()
        const title = text(component.label)
        const panels = steps.map((step, index) => {
          if (step.required != null && !Array.isArray(step.required)) throw new Error()
          const required = Array.isArray(step.required) ? step.required.map(id) : []
          const before = new Set(controlIds)
          const content = renderGroup(step.children, 1, depth)
          if (required.some(key => before.has(key) || !controlIds.has(key))) throw new Error()
          const previous = index ? `<button class="chat-smart-local-button" type="button" data-smart-step="previous">${t('previousStep')}</button>` : ''
          const next = index + 1 < steps.length ? `<button class="chat-smart-local-button" type="button" data-smart-step="next">${t('nextStep')}</button>` : ''
          return `<div class="chat-smart-wizard-panel" data-smart-step-panel="${keys[index]}" data-smart-required="${required.join(' ')}"${index ? ' hidden' : ''}>
            <div class="chat-smart-wizard-heading"><h4 tabindex="-1">${text(step.label)}</h4><span class="chat-smart-list-detail">${t('stepPosition', { current: index + 1, total: steps.length })}</span></div>
            ${content}<div class="chat-smart-wizard-actions">${previous}${next}</div></div>`
        }).join('')
        return `<section class="chat-smart-section chat-smart-wizard"><h4>${title}</h4>
          <progress value="1" max="${steps.length}" aria-label="${title}"></progress>${panels}<p role="alert" hidden>${t('requiredStep')}</p></section>`
      }
      case 'switch': {
        if (!Array.isArray(component.options) || component.options.length < 2 || component.options.length > 6) throw new Error()
        const options = component.options.map(fields)
        const keys = options.map(option => id(option.id))
        const stateKey = component.state == null ? null : id(component.state)
        const active = stateKey ? state.get(stateKey) : component.default == null ? keys[0] : id(component.default)
        if (typeof active !== 'string' || new Set(keys).size !== keys.length || !keys.includes(active)) throw new Error()
        const buttons = options.map((option, index) =>
          `<button type="button" data-smart-choice="${keys[index]}" aria-pressed="${keys[index] === active}">${text(option.label, 80)}</button>`).join('')
        const panels = options.map((option, index) =>
          `<div data-smart-panel="${keys[index]}"${keys[index] === active ? '' : ' hidden'}>${renderGroup(option.children, 1, depth)}</div>`).join('')
        return `<div class="chat-smart-switch"${stateKey ? ` data-smart-state-key="${stateKey}"` : ''}><div class="chat-smart-switch-options" role="group" aria-label="${text(component.label)}">${buttons}</div>${panels}</div>`
      }
      case 'stack':
      case 'section':
      case 'grid': {
        const columns = component.type === 'grid' ? number(component.columns ?? 2) : 1
        if (!Number.isInteger(columns) || columns < 1 || columns > 4) throw new Error()
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
        const binding = bindingAttributes(component.bind)
        const initial = component.value ?? (binding ? 0 : undefined)
        const value = typeof initial === 'number' ? number(initial) : text(initial, 80)
        return `<div class="chat-smart-metric"${colorAttribute(component.color)}${binding}><span class="chat-smart-label">${iconSlot(component.icon)}${text(component.label)}</span><strong><span>${value}</span><span data-smart-unit>${component.unit == null ? '' : text(component.unit, 20)}</span></strong></div>`
      }
      case 'progress': {
        const binding = bindingAttributes(component.bind)
        const current = number(component.value ?? (binding ? 0 : undefined)), max = number(component.max ?? 100)
        if (max <= 0 || current < 0 || current > max) throw new Error()
        const caption = text(component.label)
        return `<div class="chat-smart-progress-block"${colorAttribute(component.color)}${binding}><span class="chat-smart-label">${iconSlot(component.icon)}${caption}</span>
          <strong><span>${current}</span><span data-smart-unit>${component.unit == null ? ` / ${max}` : text(component.unit, 20)}</span></strong>
          <progress value="${current}" max="${max}" aria-label="${caption}"></progress></div>`
      }
      case 'slider': {
        const key = registerControl(component.id)
        const min = number(component.min), max = number(component.max), step = number(component.step ?? 1), current = number(component.value)
        if (min >= max || step <= 0 || step > max - min || current < min || current > max) throw new Error()
        sliders.add(key)
        const label = text(component.label)
        return `<label class="chat-smart-slider"${colorAttribute(component.color)}><span class="chat-smart-label">${iconSlot(component.icon)}${label}</span><strong data-smart-value>${current}</strong>
          <input type="range" class="progress-range" data-smart-slider="${key}" min="${min}" max="${max}" step="${step}" value="${current}" aria-label="${label}">
        </label>`
      }
      case 'input': {
        const { inputType, value } = component
        if (inputType !== 'number' && inputType !== 'text') return ''
        const key = registerControl(component.id)
        if (inputType === 'number') numericInputs.add(key)
        const label = text(component.label)
        const initial = value == null ? '' : inputType === 'number'
          ? number(value) : value === '' ? '' : text(value, 240)
        const constraints = inputType === 'text' ? 'maxlength="240"' : 'step="any"'
        return `<div class="chat-smart-input"><span class="chat-smart-label">${label}</span><input class="form-input" type="${inputType}" data-smart-input="${key}" value="${initial}" aria-label="${label}" autocomplete="off" ${constraints}></div>`
      }
      case 'checklist': {
        if (!Array.isArray(component.items) || !component.items.length || component.items.length > 30) throw new Error()
        const key = registerControl(component.id)
        const items = component.items.map(value => {
          const item = fields(value)
          const amount = number(item.value ?? 0)
          const detail = item.detail == null ? '' : `<span class="chat-smart-list-detail">${text(item.detail, 240)}</span>`
          return `<label class="chat-smart-checklist-item"><input type="checkbox" data-smart-checklist="${key}" value="${amount}"${item.checked === true ? ' checked' : ''}>
            <span><strong>${text(item.label)}</strong>${detail}</span></label>`
        })
        return `<fieldset class="chat-smart-checklist"><legend>${text(component.label)}</legend>${items.join('')}</fieldset>`
      }
      case 'button': {
        const action = component.action as Fields | null | undefined
        function buttonMarkup(tag: 'a' | 'button', attributes: string) {
          const label = text(component.label)
          const icon = iconSlot(component.icon)
          const variant = component.variant === 'tile' ? 'tile' : component.variant === 'icon' && icon ? 'icon' : ''
          const attrs = variant ? ` data-smart-button-variant="${variant}"` : ''
          const name = variant === 'icon' ? ` aria-label="${label}" title="${label}"` : ''
          const body = icon + (variant === 'icon' ? '' : `<span>${label}</span>`)
          return `<${tag} class="chat-smart-button"${attributes}${attrs}${name}>${body}</${tag}>`
        }
        if (action?.type === 'set-state' || action?.type === 'toggle-state') {
          const key = typeof action.state === 'string' ? action.state : ''
          const current = state.get(key)
          if (current === undefined) return ''
          if (action.type === 'toggle-state' && typeof current !== 'boolean') return ''
          if (action.type === 'set-state' && (typeof current !== typeof action.value
            || (typeof action.value === 'string' && action.value.length > 80))) return ''
          const value = action.type === 'set-state' ? ` data-smart-value="${escapeHtml(JSON.stringify(action.value))}"` : ''
          return buttonMarkup('button', ` type="button" data-smart-set="${key}"${value}`)
        }
        const href = actionHref(component.action)
        return href ? buttonMarkup('a', ` href="${href}"`) : ''
      }
      case 'chart': {
        const { kind, points } = component
        if ((kind !== 'line' && kind !== 'bar') || !Array.isArray(points) || !points.length || points.length > 40) throw new Error()
        const title = text(component.label)
        const unit = component.unit == null ? '' : text(component.unit, 20)
        const filter = component.filter == null ? null : fields(component.filter)
        const source = filter ? id(filter.source) : null
        if (filter && filter.operator !== 'lte' && filter.operator !== 'gte') throw new Error()
        if (source) chartFilters.add(source)
        const rows = points.map(point => {
          const item = fields(point)
          const value = item.value === null ? null : number(item.value)
          return `<li data-smart-point${value === null ? '' : ` data-smart-compare="${value}"`}><span>${text(item.label, 80)}</span><strong>${value === null ? '—' : `${value}${unit}`}</strong></li>`
        }).join('')
        return `<figure class="chat-smart-chart" data-smart-chart="${kind}" data-smart-chart-unit="${unit}"${colorAttribute(component.color)}${source ? ` data-smart-filter="${source}" data-smart-operator="${filter?.operator}"` : ''}>
          <figcaption class="chat-smart-label">${iconSlot(component.icon)}${title}</figcaption>
          <div class="chat-smart-chart-canvas"><canvas aria-hidden="true"></canvas></div>
          <details><summary><span data-smart-chart-chevron aria-hidden="true"></span>${t('chartData')}</summary><ul>${rows}</ul></details>
          <p class="chat-smart-view-notice" data-smart-empty hidden>${t('empty')}</p>
        </figure>`
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
          const href = actionHref(item.action)
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
  if (!html || [...filters].some(source => !sliders.has(source))
    || [...chartFilters].some(source => !sliders.has(source) && !numericInputs.has(source))
    || [...rankingWeights].some(source => !sliders.has(source))) throw new Error()
  const initial = state.size ? ` data-smart-state="${escapeHtml(JSON.stringify(Object.fromEntries(state)))}"` : ''
  return `<section class="chat-smart-view chat-smart-layout-view"${initial}>${html}</section>`
}

function readRatio(view: Element, numerator?: string, denominator?: string) {
  if (!numerator || !denominator || !componentId.test(numerator) || !componentId.test(denominator)) return undefined
  const top = view.querySelector<HTMLInputElement>(`input[type="range"][data-smart-slider="${numerator}"]`)?.valueAsNumber
  const bottom = view.querySelector<HTMLInputElement>(`input[type="range"][data-smart-slider="${denominator}"]`)?.valueAsNumber
  if (top === undefined || bottom === undefined) return undefined
  const percentage = top / bottom * 100
  return Number.isFinite(percentage) ? Number(percentage.toFixed(2)) : null
}

function updateBoundValue(target: HTMLElement, current: string | number | null, showActual = false) {
  const progress = target.querySelector<HTMLProgressElement>(':scope > progress')
  const numeric = typeof current === 'number' ? current : null
  if (progress) progress.value = Math.min(progress.max, Math.max(0, numeric ?? 0))
  const display = target.querySelector(':scope > strong > span:first-child')
  const shown = progress && !showActual ? numeric === null ? null : progress.value : current
  if (display) display.textContent = shown === null ? '—' : String(shown)
  const unit = target.querySelector<HTMLElement>(':scope > strong > [data-smart-unit]')
  if (unit) unit.hidden = shown === null || shown === ''
}

export function updateSmartViewControl(input: HTMLInputElement) {
  const view = input.closest('.chat-smart-layout-view')
  const { smartSlider, smartInput, smartChecklist } = input.dataset
  const key = smartSlider ?? smartInput ?? smartChecklist
  if (!view || !key || !componentId.test(key)) return
  if (smartSlider && input.type === 'range') {
    updateSmartViewSlider(input, view, key)
  } else if (smartInput && (input.type === 'number' || input.type === 'text')) {
    const value = input.type === 'text' ? input.value.slice(0, 240) : input.valueAsNumber
    for (const target of view.querySelectorAll<HTMLElement>(`[data-smart-bind="${key}"]`)) {
      updateBoundValue(target, typeof value === 'string' || Number.isFinite(value) ? value : null)
    }
    if (typeof value === 'number') updateSmartViewFilters(view, key, value)
  } else if (smartChecklist && input.type === 'checkbox') {
    const selected = [...view.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][data-smart-checklist="${key}"]:checked`)]
    const sum = Number(selected.reduce((total, option) => total + Number(option.value), 0).toFixed(8))
    for (const target of view.querySelectorAll<HTMLElement>(`[data-smart-aggregate="${key}"]`)) {
      updateBoundValue(target, target.dataset.smartOperation === 'sum' ? sum : selected.length)
    }
  }
}

function updateSmartViewSlider(input: HTMLInputElement, view: Element, key: string) {
  const value = input.valueAsNumber
  if (!Number.isFinite(value)) return
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
    updateBoundValue(target, current, !smartBind)
  }
  updateSmartViewFilters(view, key, value)
  for (const ranking of view.querySelectorAll<HTMLElement>(`[data-smart-ranking~="${key}"]`)) refreshSmartRanking(ranking)
}

function updateSmartViewFilters(view: Element, key: string, value: number) {
  for (const list of view.querySelectorAll<HTMLElement>(`[data-smart-filter="${key}"]`)) {
    const chart = Boolean(list.dataset.smartChart)
    let visible = 0
    for (const row of list.querySelectorAll<HTMLElement>(chart ? ':scope > details > ul > li[data-smart-point]' : ':scope > ul > li[data-smart-compare]')) {
      if (row.dataset.smartCompare === undefined) continue
      const item = Number(row.dataset.smartCompare)
      row.hidden = Number.isFinite(value) && (list.dataset.smartOperator === 'gte' ? item < value : item > value)
      if (!row.hidden) visible++
    }
    const empty = list.querySelector<HTMLElement>(':scope > [data-smart-empty]')
    if (empty) empty.hidden = visible > 0
    if (chart) list.dispatchEvent(new Event('smart-chart-update'))
  }
}
