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
            { type: 'grid', columns: 4, children: [
              { type: 'stack', children: [
                { type: 'button', label: '查看乙项目', action: { type: 'open-object', kind: 'project', id: 24 } },
              ] },
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
    expect(effortPanel?.querySelector('[data-columns="4"] a')).not.toBeNull()
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

it('多选实时计数和求和，数字与文字输入更新绑定目标', async () => {
  const { createApp, h, nextTick } = await import('vue')
  const { default: Citations } = await import('@/components/common/gugu-chat/GuguChatCitations.vue')
  const source = fence({ version: 1, layout: { type: 'stack', children: [
    { type: 'checklist', id: 'tasks', label: '今日待办', items: [
      { label: '整理资料', value: 1.5, checked: true }, { label: '核对清单', value: 2 },
    ] },
    { type: 'metric', label: '已选', bind: { type: 'count', source: 'tasks' }, unit: '项' },
    { type: 'metric', label: '合计', bind: { type: 'sum', source: 'tasks' }, unit: '小时' },
    { type: 'progress', label: '工时占用', max: 4, bind: { type: 'sum', source: 'tasks' } },
    { type: 'input', id: 'budget', label: '预算', inputType: 'number', value: 2.5 },
    { type: 'progress', label: '预算占用', bind: 'budget', max: 4 },
    { type: 'input', id: 'title', label: '标题', inputType: 'text', value: '<b>试排</b>' },
    { type: 'metric', label: '预览', bind: 'title' },
  ] } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(Citations, { html: renderMd(source), text: source, presenting: false }) }).use(i18n)
  app.mount(host)
  try {
    await nextTick()
    const count = host.querySelector('[data-smart-operation="count"] strong')
    const total = host.querySelector('.chat-smart-metric[data-smart-operation="sum"] strong')
    const hours = host.querySelector<HTMLProgressElement>('progress[aria-label="工时占用"]')
    expect(count?.textContent).toBe('1项')
    expect(total?.textContent).toBe('1.5小时')
    const options = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    options[1].click()
    expect(count?.textContent).toBe('2项')
    expect(total?.textContent).toBe('3.5小时')
    expect(hours?.value).toBe(3.5)
    options[0].click()
    expect(total?.textContent).toBe('2小时')
    const budget = host.querySelector<HTMLInputElement>('input[type="number"]')!
    const budgetBar = host.querySelector<HTMLProgressElement>('progress[aria-label="预算占用"]')
    expect(budgetBar?.value).toBe(2.5)
    budget.value = '3.2'
    budget.dispatchEvent(new Event('input', { bubbles: true }))
    expect(budgetBar?.value).toBe(3.2)
    budget.value = ''
    budget.dispatchEvent(new Event('input', { bubbles: true }))
    expect(budgetBar?.parentElement?.querySelector('strong > span:first-child')?.textContent).toBe('—')
    const title = host.querySelector<HTMLInputElement>('input[type="text"]')!
    const preview = host.querySelector('[data-smart-bind="title"] strong')
    expect(preview?.textContent).toBe('<b>试排</b>')
    title.value = '<img src="x">'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    expect(preview?.textContent).toBe('<img src="x">')
    expect(preview?.querySelector('img')).toBeNull()
  } finally {
    app.unmount()
    host.remove()
  }
})

it('折线图保留缺测，滑块和数字输入分别筛选绑定图表', async () => {
  const { updateSmartViewControl } = await import('@/components/common/gugu-chat/chatSmartLayout')
  const points = [{ label: '一月', value: 3 }, { label: '二月', value: null }, { label: '三月', value: 7 }]
  const host = render({ version: 1, layout: { type: 'stack', children: [
    { type: 'slider', id: 'ceiling', label: '上限', min: 0, max: 10, value: 5 },
    { type: 'input', id: 'floor', label: '下限', inputType: 'number', value: 5 },
    { type: 'chart', kind: 'line', label: '趋势', points, filter: { source: 'ceiling', operator: 'lte' } },
    { type: 'chart', kind: 'bar', label: '分布', points, filter: { source: 'floor', operator: 'gte' } },
  ] } })
  const range = host.querySelector<HTMLInputElement>('input[type="range"]')!
  const floor = host.querySelector<HTMLInputElement>('input[type="number"]')!
  const line = host.querySelector('[data-smart-chart="line"]')!
  const bar = host.querySelector('[data-smart-chart="bar"]')!
  expect(line.querySelector('canvas')).not.toBeNull()
  expect(line.querySelectorAll('[data-smart-point]')[1]?.textContent).toContain('—')
  updateSmartViewControl(range)
  updateSmartViewControl(floor)
  const visibleValues = (chart: Element) => [...chart.querySelectorAll('[data-smart-compare]:not([hidden])')].map(row => row.getAttribute('data-smart-compare'))
  expect(visibleValues(line)).toEqual(['3'])
  expect(visibleValues(bar)).toEqual(['7'])
  floor.value = '10'
  updateSmartViewControl(floor)
  expect(visibleValues(bar)).toEqual([])
  expect(bar.querySelector<HTMLElement>('[data-smart-empty]')?.hidden).toBe(false)
  floor.value = ''
  updateSmartViewControl(floor)
  expect(visibleValues(bar)).toEqual(['3', '7'])
  expect(visibleValues(line)).toEqual(['3'])
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

it('时间轴保留顺序，排名随权重改变，向导校验并保留输入', async () => {
  const { createApp, h, nextTick } = await import('vue')
  const { default: Citations } = await import('@/components/common/gugu-chat/GuguChatCitations.vue')
  const source = fence({ version: 1, layout: { type: 'stack', children: [
    { type: 'timeline', label: '进展', items: [
      { when: '11-20', label: '完成初稿', status: 'done' },
      { when: '后续', label: '交付终稿', status: 'planned', action: { type: 'open-object', kind: 'project', id: 12 } },
    ] },
    { type: 'slider', id: 'speed', label: '速度', min: 0, max: 10, value: 10 },
    { type: 'slider', id: 'size', label: '大小', min: 0, max: 10, value: 0 },
    { type: 'ranking', label: '排序', criteria: [
      { id: 'speed', label: '速度', weight: 'speed' }, { id: 'size', label: '大小', weight: 'size' },
    ], items: [
      { label: '甲', scores: { speed: 9, size: 3 } }, { label: '乙', scores: { speed: 6, size: 9 } },
    ] },
    { type: 'wizard', label: '制定计划', steps: [
      { id: 'entry', label: '输入工时', required: ['hours'], children: [
        { type: 'input', id: 'hours', label: '工时', inputType: 'number' },
      ] },
      { id: 'preview', label: '预览', children: [{ type: 'metric', label: '可用工时', bind: 'hours' }] },
    ] },
  ] } })
  const host = document.createElement('div')
  const app = createApp({ render: () => h(Citations, { html: renderMd(source), text: source, presenting: false }) }).use(i18n)
  app.mount(host)
  try {
    await nextTick()
    const milestones = [...host.querySelectorAll('.chat-smart-timeline li')]
    expect(milestones.map(item => item.querySelector('strong')?.textContent)).toEqual(['完成初稿', '交付终稿'])
    expect(milestones[1].querySelector('a')?.getAttribute('href')).toBe('gugu://open-object/project/12')
    const ranking = () => [...host.querySelectorAll('.chat-smart-ranking li strong')].map(row => row.textContent)
    expect(ranking()).toEqual(['甲', '乙'])
    const size = host.querySelector<HTMLInputElement>('input[data-smart-slider="size"]')!
    size.value = '10'
    size.dispatchEvent(new Event('input', { bubbles: true }))
    expect(ranking()).toEqual(['乙', '甲'])
    expect(host.querySelector('[data-smart-score]')?.textContent).toBe('7.5')
    host.querySelector<HTMLButtonElement>('[data-smart-reset-weights]')?.click()
    expect(ranking()).toEqual(['甲', '乙'])
    expect(size.value).toBe('0')
    const advance = host.querySelector<HTMLButtonElement>('[data-smart-step="next"]')!
    const preview = host.querySelector<HTMLElement>('[data-smart-step-panel="preview"]')!
    advance.click()
    expect(preview.hidden).toBe(true)
    expect(host.querySelector<HTMLElement>('.chat-smart-wizard [role="alert"]')?.hidden).toBe(false)
    const input = host.querySelector<HTMLInputElement>('input[data-smart-input="hours"]')!
    input.value = '3.5'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    advance.click()
    expect(preview.hidden).toBe(false)
    expect(preview.querySelector('strong')?.textContent).toBe('3.5')
    preview.querySelector<HTMLButtonElement>('[data-smart-step="previous"]')?.click()
    expect(preview.hidden).toBe(true)
    expect(input.value).toBe('3.5')
  } finally {
    app.unmount()
  }
})

it('共享状态控制双栏与会话切换，收起后保留选择且不影响另一张卡', async () => {
  const { createApp, h, nextTick } = await import('vue')
  const { default: Citations } = await import('@/components/common/gugu-chat/GuguChatCitations.vue')
  const source = fence({ version: 1, state: { panelOpen: true, session: 'main', mode: 'tabs' }, layout: {
    type: 'stack', children: [
      { type: 'button', label: '切换布局', action: { type: 'set-state', state: 'mode', value: 'drawer' } },
      { type: 'text', text: '抽屉布局', when: { state: 'mode', equals: 'drawer' } },
      { type: 'split', fixed: { side: 'primary', width: 'rail' }, secondaryWhen: { state: 'panelOpen', equals: true },
        primary: [{ type: 'toolbar', label: '工具栏', orientation: 'vertical', children: [
          { type: 'button', label: '切换右栏', icon: 'ri-apps-line', variant: 'icon', action: { type: 'toggle-state', state: 'panelOpen' } },
        ] }],
        secondary: [{ type: 'panel', label: '会话区', height: 'regular',
          header: [{ type: 'switch', label: '会话', state: 'session', options: [
            { id: 'main', label: '主助手', children: [{ type: 'text', text: '主会话消息' }] },
            { id: 'art', label: '设计', children: [{ type: 'text', text: '设计会话消息' }] },
          ] }],
          children: [{ type: 'text', text: '模拟消息区域' }],
          footer: [{ type: 'input', id: 'draft', label: '模拟输入', inputType: 'text' }],
        }],
      },
      { type: 'text', text: '当前为设计会话', when: { state: 'session', equals: 'art' } },
    ],
  } })
  const host = document.createElement('div')
  const app = createApp({ render: () => h(Citations, { html: renderMd(source + '\n\n' + source), text: source, presenting: false }) }).use(i18n)
  app.mount(host)
  try {
    await nextTick()
    const [first, second] = host.querySelectorAll('.chat-smart-layout-view')
    const action = (card: Element, key: string) => card.querySelector<HTMLButtonElement>(`button[data-smart-set="${key}"]`)!
    const right = first.querySelector<HTMLElement>('[data-smart-when="panelOpen"]')!
    const art = first.querySelector<HTMLButtonElement>('button[data-smart-choice="art"]')!
    const drawer = first.querySelector<HTMLElement>('[data-smart-when="mode"]')!
    const panel = right.querySelector('.chat-smart-panel')!
    expect(panel.querySelector('header button[data-smart-choice="art"]')).toBe(art)
    expect(panel.querySelector('.chat-smart-panel-body')?.textContent).toContain('模拟消息区域')
    expect(panel.querySelector('footer input')?.getAttribute('aria-label')).toBe('模拟输入')
    expect(action(first, 'panelOpen').getAttribute('aria-label')).toBe('切换右栏')
    expect(drawer.hidden).toBe(true)
    art.click()
    expect(art.getAttribute('aria-pressed')).toBe('true')
    expect(first.querySelector<HTMLElement>('[data-smart-when="session"]')?.hidden).toBe(false)
    action(first, 'panelOpen').click()
    expect(right.hidden).toBe(true)
    action(first, 'panelOpen').click()
    expect(right.hidden).toBe(false)
    expect(art.getAttribute('aria-pressed')).toBe('true')
    action(first, 'mode').click()
    expect(drawer.hidden).toBe(false)
    expect(second.querySelector('button[data-smart-choice="art"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(second.querySelector<HTMLElement>('[data-smart-when="mode"]')?.hidden).toBe(true)
  } finally {
    app.unmount()
  }
})

it('流式围栏先展示骨架，按完整记录填充区域，保留既有草稿', async () => {
  const { createApp, h, nextTick, ref } = await import('vue')
  const { default: Citations } = await import('@/components/common/gugu-chat/GuguChatCitations.vue')
  const header = '```gugu-ui-stream\n{"version":1,"ratio":"60:40","footer":true}\n'
  const primary = JSON.stringify({ region: 'primary', state: { session: 'main' }, layout: { type: 'stack', children: [
    { type: 'input', inputType: 'text', id: 'draft', label: '草稿' },
    { type: 'switch', label: '会话', state: 'session', options: [
      { id: 'main', label: '主会话', children: [{ type: 'text', text: '主会话内容' }] },
      { id: 'art', label: '设计', children: [{ type: 'text', text: '设计会话内容' }] },
    ] },
  ] } })
  const secondary = JSON.stringify({ region: 'secondary', layout: { type: 'text', text: '会话结果' } })
  const footer = JSON.stringify({ region: 'footer', layout: { type: 'text', text: '输入区就绪' } })
  const source = ref(header)
  const presenting = ref(true)
  const host = document.createElement('div')
  const app = createApp({ render: () => h(Citations, {
    html: presenting.value ? renderMdStream(source.value) : renderMd(source.value),
    text: source.value, presenting: presenting.value,
  }) }).use(i18n)
  app.mount(host)
  try {
    const region = (name: string) => host.querySelector(`[data-region="${name}"]`)!
    expect(region('primary').querySelector('[role="status"]')).not.toBeNull()
    expect(region('secondary').querySelector('[role="status"]')).not.toBeNull()
    source.value += primary
    await nextTick()
    expect(region('primary').querySelector('input')).toBeNull()
    source.value += '\n'
    await nextTick()
    const input = region('primary').querySelector('input')!
    input.value = '已输入草稿'
    const session = region('primary').querySelector<HTMLButtonElement>('[data-smart-choice="art"]')!
    session.click()
    source.value += '{"region":"footer","layout":{"type":"unknown"}}\n' + secondary + '\n'
    await nextTick()
    expect(region('secondary').textContent).toContain('会话结果')
    expect(region('footer').querySelector('[role="status"]')).not.toBeNull()
    expect(region('primary').querySelector('input')).toBe(input)
    source.value += footer + '\n```'
    presenting.value = false
    await nextTick()
    expect(region('footer').textContent).toContain('输入区就绪')
    expect(region('primary').querySelector('input')).toBe(input)
    expect(input.value).toBe('已输入草稿')
    expect(session.getAttribute('aria-pressed')).toBe('true')
  } finally {
    app.unmount()
  }
})

it('流式围栏闭合后单独标记 JSON 错误的区域，保留可用底栏', () => {
  const source = [
    '```gugu-ui-stream',
    '{"version":1,"footer":true}',
    '{"region":"primary","layout":{"type":"stack","children":[{"type":"text","text":"示例"}]},{"type":"text","text":"多余组件"}}',
    '{"region":"footer","layout":{"type":"button","label":"查看资料","action":{"type":"open-url","url":"https://example.com/"}}}',
    '```',
  ].join('\n')
  const host = document.createElement('div')
  host.innerHTML = sanitizeChatHtml(renderMd(source))
  const primary = host.querySelector('[data-smart-region="primary"]')
  const secondary = host.querySelector('[data-smart-region="secondary"]')
  const footer = host.querySelector('[data-smart-region="footer"]')
  expect(primary?.textContent).toContain(i18n.global.t('smartView.invalidRegion'))
  expect(secondary?.textContent).toContain(i18n.global.t('smartView.unavailable'))
  expect(footer?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/')
})

it('DSL 与 JSON 共用稳定样式，具名区域生效，未闭合时保留占位', async () => {
  const { compileSmartDsl } = await import('@/components/common/gugu-chat/chatSmartDsl')
  const body = [
    'state panelOpen=true',
    'split ratio="60:40" secondaryWhen={"state":"panelOpen","equals":true} {',
    '  @primary {',
    '    panel label="" {',
    '      grid columns=2 gap=compact surface=soft {',
    '        toolbar {',
    '          button label="切换右栏" label=切换右栏 action={"type":"toggle-state","state":"panelOpen"}',
    '        }',
    '      }',
    '    }',
    '  }',
    '  @secondary {',
    '    text text="模拟会话 {保留原文}" padding=roomy radius=medium',
    '    progress label=进度 value=67 unit=%',
    '  }',
    '}',
  ].join('\n')
  const opening = '```gugu-ui-dsl\n'
  const html = sanitizeChatHtml(renderMd(opening + body + '\n```'))
  const json = compileSmartDsl(body)
  expect(html.trim()).toBe(sanitizeChatHtml(renderMd(fence(json))).replace('<p>摘要</p>', '').trim())
  const host = document.createElement('div')
  host.innerHTML = html
  const panel = host.querySelector('.chat-smart-panel')
  expect(panel).not.toBeNull()
  expect(panel?.querySelector('header')).toBeNull()
  expect(panel?.hasAttribute('aria-label')).toBe(false)
  expect(host.querySelector('.chat-smart-toolbar button')?.textContent).toBe('切换右栏')
  expect(host.querySelector('[data-smart-style-gap], [data-smart-style-surface]')).toBeNull()
  expect(host.querySelector('[data-smart-when="panelOpen"]')?.textContent).toContain('模拟会话 {保留原文}')
  expect(host.querySelector('.chat-smart-progress-block')?.textContent).toContain('67%')
  expect(renderMd(opening + 'text text=甲 text=乙\n```')).toContain(i18n.global.t('smartView.unavailable'))
  expect(renderMdStream(opening + body)).toContain(i18n.global.t('smartView.generating'))
  expect(renderMd(opening + 'text text=alert(1)\n```')).toContain(i18n.global.t('smartView.unavailable'))
})

it('网页动作沿用聊天外链行为，无效地址不生成导航入口', () => {
  const host = render({ version: 1, layout: { type: 'stack', children: [
    { type: 'button', label: '打开网页', action: { type: 'open-url', url: 'https://example.com/?a=1&b=2' } },
    { type: 'button', label: '无效地址', action: { type: 'open-url', url: 'javascript:alert(1)' } },
    { type: 'list', items: [
      { label: '公开资料', action: { type: 'open-url', url: 'http://example.com/docs' } },
      { label: '普通记录', action: { type: 'open-url', url: 'https://user@example.com/' } },
    ] },
  ] } })
  const links = [...host.querySelectorAll<HTMLAnchorElement>('.chat-smart-view a')]
  expect(links.map(link => link.getAttribute('href'))).toEqual(['https://example.com/?a=1&b=2', 'http://example.com/docs'])
  expect(links.every(link => link.target === '_blank' && link.relList.contains('noopener') && link.relList.contains('noreferrer'))).toBe(true)
  expect(host.textContent).not.toContain('无效地址')
  expect(host.textContent).toContain('普通记录')
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
