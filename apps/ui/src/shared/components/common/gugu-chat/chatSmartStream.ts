import { i18n } from '@/i18n'
import { escapeHtml } from '@/utils/escapeHtml'
import { renderSmartView } from './chatSmartViews'

const regionNames = ['primary', 'secondary', 'footer'] as const
type RegionName = typeof regionNames[number]

export interface SmartStreamRegion {
  name: RegionName
  html: string
  status: 'ready' | 'pending' | 'unavailable' | 'invalid'
}

export interface SmartStreamLayout {
  ratio: string
  regions: SmartStreamRegion[]
}

function record(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function renderSmartStream(source: string, partial = false) {
  const message = (key: 'generating' | 'unavailable' | 'invalidRegion') => escapeHtml(i18n.global.t(`smartView.${key}`))
  const unavailable = () => `<p class="chat-smart-view-notice">${message('unavailable')}</p>`
  const generating = `<span role="status">${message('generating')}</span>`
  if (source.length > 24_000) return unavailable()
  const lines = source.split('\n')
  if (partial) lines.pop()
  const [first, ...rest] = lines.filter(line => line.trim())
  const header = first ? record(first) : undefined
  const ratio = header?.ratio ?? '60:40'
  if (header?.version !== 1 || (ratio !== '50:50' && ratio !== '60:40' && ratio !== '40:60')) {
    return partial
      ? `<section class="chat-smart-view chat-smart-view-generating">${generating}</section>`
      : unavailable()
  }
  const expected = regionNames.filter(region => region !== 'footer' || header.footer === true)
  const regions = new Map<RegionName, string>()
  const invalid = new Set<RegionName>()
  for (const line of rest) {
    const update = record(line)
    const declaredRegion = update?.region ?? /^\s*\{\s*"region"\s*:\s*"(primary|secondary|footer)"/.exec(line)?.[1]
    const region = expected.find(name => name === declaredRegion)
    if (!region || regions.has(region)) continue
    const html = update?.layout && renderSmartView(JSON.stringify({ version: 1, layout: update.layout, state: update.state }))
    if (typeof html === 'string' && html.startsWith('<section')) regions.set(region, html)
    else invalid.add(region)
  }
  return `<section class="chat-smart-view" data-smart-stream="${ratio}">${expected.map(name => {
    const html = regions.get(name)
    const status = html ? 'ready' : partial ? 'pending' : invalid.has(name) ? 'invalid' : 'unavailable'
    const notice = status === 'invalid' ? `<p class="chat-smart-view-notice">${message('invalidRegion')}</p>` : unavailable()
    return `<div data-smart-region="${name}" data-smart-region-status="${status}">${html ?? (partial ? generating : notice)}</div>`
  }).join('')}</section>`
}

export function readSmartStream(node: HTMLElement): SmartStreamLayout | undefined {
  const ratio = node.dataset.smartStream
  if (!ratio) return
  const regions = regionNames.flatMap(name => {
    const region = [...node.children].find(child => child.getAttribute('data-smart-region') === name)
    if (!(region instanceof HTMLElement)) return []
    const status = region.dataset.smartRegionStatus
    if (status !== 'ready' && status !== 'pending' && status !== 'unavailable' && status !== 'invalid') return []
    return [{ name, html: region.innerHTML, status }]
  })
  return { ratio, regions }
}
