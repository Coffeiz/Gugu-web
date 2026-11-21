function rankingSliders(ranking: HTMLElement) {
  const inputs = ranking.closest('.chat-smart-layout-view')?.querySelectorAll<HTMLInputElement>('input[type="range"][data-smart-slider]') ?? []
  const byKey = new Map([...inputs].map(input => [input.dataset.smartSlider, input]))
  return (ranking.dataset.smartRanking ?? '').split(' ').map(key => byKey.get(key))
}

export function refreshSmartRanking(ranking: HTMLElement) {
  const list = ranking.querySelector('ol')
  if (!list) return
  const weights = rankingSliders(ranking).map(input => Math.max(0, input?.valueAsNumber ?? 0))
  const total = weights.reduce((sum, value) => sum + value, 0)
  const rows = [...list.querySelectorAll<HTMLElement>(':scope > li')].map(row => {
    const scores = (row.dataset.smartScores ?? '').split(' ').map(Number)
    const score = total ? weights.reduce((sum, weight, index) => sum + weight * scores[index], 0) / total : null
    const label = row.querySelector('[data-smart-score]')
    if (label) label.textContent = score === null ? '—' : score.toFixed(1)
    const progress = row.querySelector('progress')
    if (progress) progress.value = score ?? 0
    return { row, score: score ?? 0, order: Number(row.dataset.smartOrder) }
  })
  rows.sort((a, b) => b.score - a.score || a.order - b.order)
  list.append(...rows.map(({ row }) => row))
}

export function handleSmartInteractiveClick(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  const button = target.closest<HTMLButtonElement>('.chat-smart-layout-view button')
  if (!button) return false
  if (button.dataset.smartSet) {
    const view = button.closest<HTMLElement>('.chat-smart-layout-view')
    if (!view?.dataset.smartState) return false
    const serialized = button.dataset.smartValue
    try {
      const value = serialized === undefined ? undefined : JSON.parse(serialized)
      if (value === undefined || typeof value === 'boolean' || typeof value === 'string') {
        changeCardState(view, button.dataset.smartSet, value)
      }
    } catch { /* 无效的卡片状态描述不执行动作。 */ }
    return true
  }
  if (button.hasAttribute('data-smart-reset-weights')) {
    const ranking = button.closest<HTMLElement>('[data-smart-ranking]')
    for (const slider of ranking ? rankingSliders(ranking) : []) {
      if (!slider) continue
      slider.value = slider.defaultValue
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return true
  }
  if (button.dataset.smartStep !== 'next' && button.dataset.smartStep !== 'previous') return false
  const wizard = button.closest<HTMLElement>('.chat-smart-wizard')
  if (!wizard) return false
  const panels = [...wizard.querySelectorAll<HTMLElement>(':scope > [data-smart-step-panel]')]
  const index = panels.findIndex(panel => !panel.hidden)
  const forward = button.dataset.smartStep === 'next'
  const next = panels[index + (forward ? 1 : -1)]
  if (!next) return true
  const current = panels[index]
  const alert = wizard.querySelector<HTMLElement>(':scope > [role="alert"]')
  if (forward && !validateStep(current)) {
    if (alert) alert.hidden = false
    return true
  }
  if (alert) alert.hidden = true
  current.hidden = true
  next.hidden = false
  const progress = wizard.querySelector<HTMLProgressElement>(':scope > progress')
  if (progress) progress.value = index + (forward ? 2 : 0)
  next.querySelector<HTMLElement>(':scope > .chat-smart-wizard-heading > h4')?.focus()
  return true
}

function validateStep(panel: HTMLElement) {
  const controls = [...panel.querySelectorAll<HTMLInputElement>('input')]
  for (const key of (panel.dataset.smartRequired ?? '').split(' ').filter(Boolean)) {
    const matches = controls.filter(input => [input.dataset.smartInput, input.dataset.smartSlider, input.dataset.smartChecklist].includes(key))
    const valid = matches.some(input => input.type === 'checkbox' ? input.checked : input.value.trim() && input.validity.valid)
    if (!valid) {
      matches[0]?.focus()
      return false
    }
  }
  return true
}
type SmartStateValue = string | boolean
const cardStates = new WeakMap<Element, Map<string, SmartStateValue>>()

function selectPanel(group: Element, selected: string) {
  for (const option of group.querySelectorAll<HTMLElement>(':scope > .chat-smart-switch-options > [data-smart-choice]')) {
    option.setAttribute('aria-pressed', String(option.dataset.smartChoice === selected))
  }
  for (const panel of group.querySelectorAll<HTMLElement>(':scope > [data-smart-panel]')) {
    panel.hidden = panel.dataset.smartPanel !== selected
  }
}

function changeCardState(view: HTMLElement, key: string, value: SmartStateValue | undefined) {
  let state = cardStates.get(view)
  if (!state) {
    try {
      state = new Map(Object.entries(JSON.parse(view.dataset.smartState ?? '{}')) as [string, SmartStateValue][])
    } catch {
      return
    }
    cardStates.set(view, state)
  }
  const current = state.get(key)
  const next = value === undefined && typeof current === 'boolean' ? !current : value
  if (next === undefined || typeof current !== typeof next) return
  state.set(key, next)
  for (const section of view.querySelectorAll<HTMLElement>('[data-smart-when]')) {
    const stateKey = section.dataset.smartWhen!
    section.hidden = JSON.stringify(state.get(stateKey)) !== section.dataset.smartEquals
  }
  for (const group of view.querySelectorAll<HTMLElement>('.chat-smart-switch[data-smart-state-key]')) {
    const selected = state.get(group.dataset.smartStateKey!)
    if (typeof selected === 'string') selectPanel(group, selected)
  }
}

export function selectSmartViewOption(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  const button = target.closest<HTMLButtonElement>('.chat-smart-layout-view button[data-smart-choice]')
  const group = button?.closest<HTMLElement>('.chat-smart-switch')
  const view = group?.closest<HTMLElement>('.chat-smart-layout-view')
  const selected = button?.dataset.smartChoice
  if (!group || !view || !selected) return false
  const key = group.dataset.smartStateKey
  if (key) changeCardState(view, key, selected)
  else selectPanel(group, selected)
  return true
}
