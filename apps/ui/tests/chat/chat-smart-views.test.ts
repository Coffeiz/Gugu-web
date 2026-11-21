// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { i18n } from '@/i18n'
import { sanitizeChatHtml } from '@/utils/markdown'
import { renderMd, renderMdStream } from '@/components/common/gugu-chat/markdown'

const fence = (data: object) => ['摘要', '', '```gugu-ui', JSON.stringify(data), '```'].join('\n')

function render(data: object) {
  const host = document.createElement('div')
  host.innerHTML = sanitizeChatHtml(renderMd(fence(data)))
  return host
}

it('项目概览按截止日排序，保留进度并仅生成允许的项目入口', () => {
  const host = render({ template: 'project-overview', date: '2026-01-15', items: [
    { id: 2, name: '示例项目乙', due_date: '2026-01-18' },
    { id: 1, name: '<img onerror=alert(1)>', due_date: '2026-01-12', stage: '执行', progress: 60, href: 'javascript:alert(1)' },
  ] })
  const links = [...host.querySelectorAll('.chat-smart-row')]
  expect(links.map(link => link.getAttribute('href'))).toEqual(['gugu://open-object/project/1', 'gugu://open-object/project/2'])
  expect(links[0]?.textContent).toContain('<img onerror=alert(1)>')
  expect(links[0]?.querySelector('progress')?.getAttribute('value')).toBe('60')
  expect(links[0]?.querySelector('.chat-smart-status')?.textContent).toBe(i18n.global.t('smartView.overdue'))
  expect(host.querySelector('img')).toBeNull()
})

it('今日日程把全天项排在最前面，时间段和详情入口可用', () => {
  const host = render({ template: 'today-agenda', date: '2026-01-15', items: [
    { id: 2, name: '会议', start_time: '11:00', end_time: '12:00' },
    { id: 1, name: '全天事项', all_day: true },
  ] })
  const links = [...host.querySelectorAll('.chat-smart-row')]
  expect(links.map(link => link.getAttribute('href'))).toEqual(['gugu://open-object/event/1', 'gugu://open-object/event/2'])
  expect(links[1]?.textContent).toContain('11:00–12:00')
})

it('空结果有提示，未知模板与未闭合围栏保留正文', () => {
  const host = render({ template: 'today-agenda', date: '2026-01-15', items: [] })
  expect(host.textContent).toContain(i18n.global.t('smartView.empty'))
  const unknown = render({ template: 'unrecognized' })
  expect(unknown.querySelector('.chat-smart-view')).toBeNull()
  expect(unknown.textContent).toContain('摘要')
  const streaming = renderMdStream('摘要\n\n```gugu-ui\n{"template":"today-agenda"')
  expect(streaming).toContain('摘要')
  expect(streaming).toContain(i18n.global.t('smartView.generating'))
  expect(streaming).not.toContain('today-agenda')
  const completed = renderMdStream(fence({ template: 'today-agenda', date: '2026-01-15', items: [] }))
  expect(completed).toContain(i18n.global.t('smartView.empty'))
  expect(completed).not.toContain(i18n.global.t('smartView.generating'))
})

it('滑块同步更新绑定指标和进度，并在混入异常项时继续筛选列表', async () => {
  const { createApp, h, nextTick } = await import('vue')
  const { default: Citations } = await import('@/components/common/gugu-chat/GuguChatCitations.vue')
  const source = fence({ version: 1, layout: { type: 'stack', children: [
    { type: 'grid', columns: 2, children: [
      { type: 'metric', label: '进行中', value: 2, icon: 'ri-trello-line' },
      { type: 'progress', label: '项目进度', value: 62, unit: '%', icon: 'unregistered' },
      { type: 'input', label: '未知控件' },
    ] },
    { type: 'button', label: '无效按钮', action: { type: 'submit', id: 12 } },
    { type: 'switch', label: '比较口径', default: 'deadline', options: [
      { id: 'deadline', label: '按截止日', children: [{ type: 'text', text: '甲项目先到期' }] },
      { id: 'effort', label: '按工作量', children: [
        { type: 'grid', columns: 2, children: [
          { type: 'section', title: '乙项目更快收尾', children: [
            { type: 'grid', columns: 2, children: [
              { type: 'button', label: '查看乙项目', action: { type: 'open-object', kind: 'project', id: 24 } },
            ] },
          ] },
        ] },
      ] },
    ] },
    { type: 'metric', label: '筛选上限', bind: 'threshold', unit: '%' },
    { type: 'progress', label: '筛选进度', bind: 'threshold', max: 80, unit: '点' },
    { type: 'slider', id: 'threshold', label: '进度上限', min: 0, max: 100, value: 65 },
    { type: 'slider', id: 'total', label: '总量', min: 0, max: 200, value: 100 },
    { type: 'progress', label: '使用比例', bind: { type: 'ratio', numerator: 'threshold', denominator: 'total' }, unit: '%' },
    { type: 'metric', label: '使用比例', bind: { type: 'ratio', numerator: 'threshold', denominator: 'total' }, unit: '%' },
    { type: 'list', filter: { slider: 'threshold', operator: 'lte' }, items: [
      { label: '项目甲', value: 62, action: { type: 'open-object', kind: 'project', id: 12 } },
      { label: '项目乙', value: 90, action: { type: 'open-object', kind: 'file', id: 34 } },
    ] },
    { type: 'button', label: '打开项目', action: { type: 'open-object', kind: 'project', id: 12 } },
  ] } }) + '\n\n后续说明'
  const host = document.createElement('div')
  const app = createApp({ render: () => h(Citations, { html: renderMd(source), text: source, presenting: false }) }).use(i18n)
  app.mount(host)
  try {
    await nextTick()
    const blocks = host.querySelector('.chat-assistant-content')?.children
    expect(blocks?.length).toBe(3)
    expect(blocks?.[0]?.textContent?.trim()).toBe('摘要')
    expect(blocks?.[1]?.querySelector('.chat-smart-view')?.closest('.msg-bubble')).toBeNull()
    expect(blocks?.[2]?.textContent?.trim()).toBe('后续说明')
    const choice = host.querySelector<HTMLButtonElement>('button[data-smart-choice="effort"]')
    const effortPanel = host.querySelector<HTMLElement>('[data-smart-panel="effort"]')
    const deadlinePanel = host.querySelector<HTMLElement>('[data-smart-panel="deadline"]')
    expect(effortPanel?.hidden).toBe(true)
    expect(deadlinePanel?.hidden).toBe(false)
    choice?.click()
    expect(choice?.getAttribute('aria-pressed')).toBe('true')
    expect(effortPanel?.hidden).toBe(false)
    expect(effortPanel?.querySelector('a')?.getAttribute('href')).toBe('gugu://open-object/project/24')
    expect(deadlinePanel?.hidden).toBe(true)
    const slider = host.querySelector<HTMLInputElement>('input[type=range]')!
    const metric = host.querySelector('.chat-smart-metric[data-smart-bind] strong')
    const boundProgress = host.querySelector<HTMLProgressElement>('.chat-smart-progress-block[data-smart-bind] progress')
    const progressLabel = boundProgress?.parentElement?.querySelector('strong')
    const total = host.querySelector<HTMLInputElement>('input[data-smart-slider="total"]')!
    const ratio = host.querySelector<HTMLProgressElement>('.chat-smart-progress-block[data-smart-numerator] progress')
    const ratioLabel = ratio?.parentElement?.querySelector('strong')
    const ratioMetric = host.querySelector('.chat-smart-metric[data-smart-numerator] strong > span:first-child')
    const rows = [...host.querySelectorAll<HTMLElement>('[data-smart-compare]')]
    expect(metric?.textContent).toBe('65%')
    expect(boundProgress?.value).toBe(65)
    expect(progressLabel?.textContent).toBe('65点')
    expect(ratio?.value).toBe(65)
    expect(host.textContent).not.toContain('未知控件')
    expect(host.textContent).not.toContain('无效按钮')
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('gugu://open-object/project/12')
    expect(rows[1]?.textContent).toContain('项目乙')
    expect(rows[1]?.querySelector('a')).toBeNull()
    expect(rows.map(row => row.hidden)).toEqual([false, true])
    expect(host.querySelector('[data-smart-icon="ri-trello-line"] svg')).not.toBeNull()
    expect(host.querySelector('[data-smart-icon="unregistered"]')).toBeNull()
    slider.value = '95'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    expect(rows.map(row => row.hidden)).toEqual([false, false])
    expect(metric?.textContent).toBe('95%')
    expect(boundProgress?.value).toBe(80)
    expect(progressLabel?.textContent).toBe('80点')
    slider.value = '30'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    expect(rows.map(row => row.hidden)).toEqual([true, true])
    expect(metric?.textContent).toBe('30%')
    expect(boundProgress?.value).toBe(30)
    expect(ratio?.value).toBe(30)
    total.value = '80'
    total.dispatchEvent(new Event('input', { bubbles: true }))
    expect(ratio?.value).toBe(37.5)
    expect(ratioLabel?.textContent).toBe('37.5%')
    expect(ratioMetric?.textContent).toBe('37.5')
    total.value = '0'
    total.dispatchEvent(new Event('input', { bubbles: true }))
    expect(ratio?.value).toBe(0)
    expect(ratioMetric?.textContent).toBe('—')
    expect(ratioLabel?.querySelector<HTMLElement>('[data-smart-unit]')?.hidden).toBe(true)
    total.value = '20'
    total.dispatchEvent(new Event('input', { bubbles: true }))
    expect(ratio?.value).toBe(100)
    expect(ratioLabel?.textContent).toBe('150%')
    expect(ratioLabel?.querySelector<HTMLElement>('[data-smart-unit]')?.hidden).toBe(false)
    expect(host.querySelector<HTMLElement>('[data-smart-empty]')?.hidden).toBe(false)
    const standaloneButton = [...host.querySelectorAll('.chat-smart-button')].find(button => button.textContent === '打开项目')
    expect(standaloneButton?.getAttribute('href')).toBe('gugu://open-object/project/12')
    expect(host.querySelector('progress')?.getAttribute('value')).toBe('62')
  } finally {
    app.unmount()
  }
})

it('智能界面保留允许的颜色，忽略未知颜色并继续展示组件', () => {
  const host = render({ version: 1, layout: { type: 'stack', children: [
    { type: 'text', text: '需关注', color: 'warning' },
    { type: 'metric', label: '已完成', value: 2, color: 'success' },
    { type: 'progress', label: '项目进度', value: 62, color: 'info' },
    { type: 'slider', id: 'threshold', label: '进度上限', min: 0, max: 100, value: 65, color: 'accent' },
    { type: 'text', text: '默认颜色', color: 'danger" style="color:red' },
  ] } })
  const view = host.querySelector('.chat-smart-layout-view')!
  expect([...view.querySelectorAll<HTMLElement>('[data-smart-color]')]
    .map(element => element.dataset.smartColor)).toEqual(['warning', 'success', 'info', 'accent'])
  expect(view.textContent).toContain('默认颜色')
  expect(view.querySelector('[style]')).toBeNull()
})

it('无效布局和未注册动作不生成控件', () => {
  for (const layout of [
    { type: 'section', title: '空分区', children: [{ type: 'input' }] },
    { type: 'button', label: '执行', action: { type: 'submit', id: 12 } },
    { type: 'button', label: '执行', action: { type: 'open-object', kind: 'file', id: 12 } },
    { type: 'list', filter: { slider: 'missing', operator: 'lte' }, items: [] },
  ]) {
    const host = render({ version: 1, layout })
    expect(host.querySelector('.chat-smart-layout-view')).toBeNull()
    expect(host.textContent).toContain(i18n.global.t('smartView.unavailable'))
  }
})
