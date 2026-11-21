// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createApp, effectScope, h, nextTick, shallowRef } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'
import { mindAccessKey } from '@/services/mindAccess'
import { webMindAccess } from '@web/mind/access'
import { projectAccessKey } from '@/api/projects'
import { pathFileAccessKey } from '@/services/pathFileAccess'
import { webProjectAccess } from '@web/projects/access'
import GuguChatComposer from '@/components/common/gugu-chat/GuguChatComposer.vue'
import { byokApi, pathFilesApi } from '@/services/api'
import { createWebChatModelCatalog } from '@web/chat/modelCatalog'
import { chatCitationSiteKey, chatModelCatalogKey, chatToolDetailsKey, type ChatModelCatalog } from '@/components/common/gugu-chat/chatPresentationAccess'
import GuguChatMessageRow from '@/components/common/gugu-chat/GuguChatMessageRow.vue'
import GuguChatCitations from '@/components/common/gugu-chat/GuguChatCitations.vue'
import { applyChatCardSnapshots, stripChatCardSnapshotMarkers } from '@/components/common/gugu-chat/chatCardSnapshots'
import { decorateChatSources, readChatSources } from '@/components/common/gugu-chat/chatSources'
import { mapSessionMessageDelta } from '@/components/common/gugu-chat/composables/sessionMessageSync'
import { findClickedChatReference, type ChatMessage, type ChatReference } from '@/components/common/gugu-chat/chatTypes'
import { useChatSources } from '@/components/common/gugu-chat/useChatSources'
import { renderChatMd } from '@/components/common/gugu-chat/markdown'
import { sanitizeChatHtml } from '@/utils/markdown'
import { projectDeadlinePresentation } from '@/composables/shared/useProjectCardBasics'
import { runtime } from '@/interaction/runtime'
import { provideRuntime } from '@/interaction/runtime/vue'

function mountComposer(catalog: ChatModelCatalog, references: ChatReference[] = []) {
  const onReferenceClick = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const noop = () => {}
  const props = {
    textOnly: !catalog.supportsServerDefault, modelValue: references.length ? '查看 @本机文件.txt 和 @合成项目' : '',
    references, pendingAtt: [], attUploading: false, recording: false, voiceInputAvailable: false,
    recordSecs: 0, expanded: false, ownerZ: 0, streaming: false, vw: 800,
    automaticModeEnabled: false, automaticModeAvailable: false, automaticModeSaving: false,
    onToggleAutomaticMode: noop, onRemoveAtt: noop, onStartRecord: noop, onCancelRecord: noop,
    onStopRecord: noop, onFilePicked: noop, onPaste: noop, onReferenceClick, onSend: noop, onStopStreaming: noop,
  }
  const composer = shallowRef<InstanceType<typeof GuguChatComposer>>()
  const app = createApp({
    setup() {
      provideRuntime(runtime)
      return () => h(GuguChatComposer, { ...props, ref: composer })
    },
  }).use(createPinia()).use(i18n)
  app.provide(mindAccessKey, webMindAccess)
  app.provide(projectAccessKey, webProjectAccess)
  app.provide(chatModelCatalogKey, catalog)
  app.mount(host)
  return { app, host, composer, onReferenceClick }
}

it('Web 模型选择保留配置默认、显式服务端默认和固定模型', async () => {
  const key = 'gugu:chat-model:42'
  localStorage.removeItem(key)
  const list = vi.spyOn(byokApi, 'list').mockResolvedValue({
    enabled: true,
    items: [
      { id: 7, capability: 'llm', has_value: true, enabled: true, model: '配置默认模型' },
      { id: 8, capability: 'llm', has_value: true, enabled: false, model: '备用模型' },
    ],
  } as Awaited<ReturnType<typeof byokApi.list>>)
  const { app, host, composer } = mountComposer(createWebChatModelCatalog(() => 42))

  async function select(label: string) {
    const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.global.t('chatComposer.model')}"]`)
    trigger?.click()
    await nextTick()
    const option = [...document.querySelectorAll<HTMLButtonElement>('.chat-composer-option')]
      .find(button => button.textContent?.trim() === label)
    expect(option).toBeDefined()
    option?.click()
    await nextTick()
  }

  try {
    await vi.waitFor(() => expect(composer.value?.selectedCredentialId()).toBe(7))
    await select(i18n.global.t('chatComposer.defaultModel'))
    expect(composer.value?.selectedCredentialId()).toBeNull()
    expect(localStorage.getItem(key)).toBe('server')
    await select('备用模型')
    expect(composer.value?.selectedCredentialId()).toBe(8)
    expect(localStorage.getItem(key)).toBe('8')
  } finally {
    app.unmount()
    host.remove()
    list.mockRestore()
    localStorage.removeItem(key)
  }
})

it('Desktop 固定本机模型时不传 Web 凭据 ID', async () => {
  const key = 'test:desktop-chat-model'
  localStorage.setItem(key, '本机备用')
  const { app, host, composer } = mountComposer({
    selectionKey: key,
    list: async () => ({
      defaultId: '本机默认',
      items: [{ id: '本机默认', model: '默认模型' }, { id: '本机备用', model: '备用模型' }],
    }),
  })

  try {
    await vi.waitFor(() => expect(composer.value?.selectedModelId()).toBe('本机备用'))
    expect(composer.value?.selectedCredentialId()).toBeUndefined()
  } finally {
    app.unmount()
    host.remove()
    localStorage.removeItem(key)
  }
})

it('点击输入框内的文件和项目引用会打开对应对象，点击普通文字不会', async () => {
  const references: ChatReference[] = [
    { type: 'file', id: 'drop-example', label: '本机文件.txt' },
    { type: 'project', id: 21, label: '合成项目' },
  ]
  const { app, host, onReferenceClick } = mountComposer({
    selectionKey: 'test:chat-model', list: async () => ({ items: [] }),
  }, references)
  try {
    await vi.waitFor(() => expect(host.querySelectorAll('.mind-ref-label')).toHaveLength(references.length))
    host.querySelector('.chat-prosemirror p')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onReferenceClick).not.toHaveBeenCalled()
    for (const label of host.querySelectorAll<HTMLElement>('.mind-ref-label')) label.click()
    expect(onReferenceClick.mock.calls).toEqual(references.map(reference => [reference]))
  } finally {
    app.unmount()
    host.remove()
  }
})

it('含 Markdown 和 HTML 字符的引用仍可点击，并保留原始文件名和引用 ID', () => {
  const references: ChatReference[] = [
    { type: 'file', id: 'drop-example', label: '进度 & *复盘* [v2] <草稿>.txt' },
    { type: 'project', id: 21, label: '进度' },
  ]
  const message = document.createElement('div')
  message.innerHTML = sanitizeChatHtml(renderChatMd(
    `查看 @${references[0]!.label} 和 @进度，保留 **加粗**。`, references,
  ))
  const chips = [...message.querySelectorAll('.chat-reference')]
  expect(chips.map(chip => chip.textContent)).toEqual(references.map(reference => reference.label))
  expect(chips.map(chip => findClickedChatReference(chip.querySelector('.mind-ref-label'), references))).toEqual(references)
  expect(message.querySelector('strong')?.textContent).toBe('加粗')
})

it('代码和链接中的同名字面量保留普通文字', () => {
  const references: ChatReference[] = [{ type: 'file', id: 'drop-example', label: 'A & B.txt' }]
  const message = document.createElement('div')
  message.innerHTML = sanitizeChatHtml(renderChatMd(
    '`@A & B.txt` [@A & B.txt](https://example.test "查看 @A & B.txt") 和 @A & B.txt', references,
  ))
  expect(message.querySelector('code')?.textContent).toBe('@A & B.txt')
  expect(message.querySelector('a')?.textContent).toBe('@A & B.txt')
  expect(message.querySelector('a')?.title).toBe('查看 @A & B.txt')
  expect(message.querySelectorAll('.chat-reference')).toHaveLength(1)
})

it.each(['', '查看 @合成项目'])('正文为 %j 时保留未写进正文的引用卡片', text => {
  const references: ChatReference[] = [
    { type: 'project', id: 21, label: '合成项目' },
    { type: 'file', id: 'drop-example', label: '原件 & 资料.txt' },
  ]
  const message = document.createElement('div')
  message.innerHTML = sanitizeChatHtml(renderChatMd(text, [...references, references[1]!]))
  const chips = [...message.querySelectorAll('.chat-reference')]
  expect(chips.map(chip => findClickedChatReference(chip, references))).toEqual(references)
})

it('联网引用仅合并紧邻的匹配链接，普通链接和应用内引用原样保留', () => {
  const sources = readChatSources({ organic: [
    { link: 'https://a.example.test/a', site_name: '示例甲', title: '甲标题', snippet: '甲摘要' },
    { url: 'https://b.example.test/b', title: '乙标题', content: '乙摘要' },
    { url: 'https://a.example.test/other', title: '另一篇' },
  ] })
  const markdown = '参考 [甲](https://a.example.test/a) [乙](https://b.example.test/b)，另见 [普通](https://a.example.test/unmatched) 和 [项目](gugu://open-object/project/1)。\n\n[另一篇](https://a.example.test/other)'
  const decorated = decorateChatSources(renderChatMd(markdown), sources)
  const host = document.createElement('div')
  host.innerHTML = sanitizeChatHtml(decorated.html)
  expect([...host.querySelectorAll('a')].map(anchor => anchor.textContent)).toEqual(['甲 +1', '普通', expect.stringContaining('项目'), '另一篇'])
  expect(decorated.groups.map(group => group.map(item => item.title))).toEqual([['甲标题', '乙标题'], ['另一篇']])
  expect(decorated.groups.map(group => group.map(item => item.summary))).toEqual([['甲摘要', '乙摘要'], ['']])
})

it('来源站点优先使用发布者名称，缺失时显示域名并标记待查询', () => {
  const sources = readChatSources({ results: [
    { url: 'https://news.163.com/article', title: '文章一' },
    { url: 'https://www.example.org/entry', publisher: { name: '示例媒体' }, title: '文章二' },
    { url: 'https://www.example.net/entry', title: '文章三' },
    { url: 'https://163.com.example.org/entry', title: '文章四' },
    { url: 'https://news.qq.com/entry', title: '文章五' },
    { url: 'https://ysxw.cctv.cn/entry', title: '文章六' },
    { url: 'https://paper.ce.cn/entry', title: '文章七' },
    { url: 'https://wallstreetcn.com/entry', title: '文章八' },
  ] })
  expect(sources.map(source => source.site)).toEqual([
    'news.163.com', '示例媒体', 'example.net', '163.com.example.org', 'news.qq.com', 'ysxw.cctv.cn', 'paper.ce.cn', 'wallstreetcn.com',
  ])
  expect(sources.map(source => source.needsSiteName === true)).toEqual([true, false, true, true, true, true, true, true])
})

it('来源胶囊保留 Markdown 名称，仅裸地址随站点查询更新', async () => {
  const links = ['https://example.org/a?tracking=synthetic', 'https://example.org/b']
  const sources = readChatSources(links.map(url => ({ url, title: '文章标题' })))
  let finish!: (value: { name: string }) => void
  const read = vi.fn(() => new Promise<{ name: string }>(resolve => { finish = resolve }))
  const text = `[示例媒体报道](${links[0]})，[${links[1]}](${links[1]})`
  const host = document.createElement('div')
  const app = createApp({ render: () => h(GuguChatCitations, {
    html: renderChatMd(text), text, sources, presenting: false,
  }) }).use(i18n).provide(chatCitationSiteKey, read)
  app.mount(host)
  const labels = () => [...host.querySelectorAll('.chat-source-pill')].map(link => link.textContent)
  try {
    expect(labels()).toEqual(['示例媒体报道', 'example.org'])
    await vi.waitFor(() => expect(read).toHaveBeenCalledExactlyOnceWith('https://example.org/a'))
    finish({ name: '示例站点' })
    await vi.waitFor(() => expect(labels()).toEqual(['示例媒体报道', '示例站点']))
  } finally { app.unmount() }
})

it('历史卡片在对象不可用时恢复同一消息的只读快照', () => {
  const href = 'gugu://open-object/event/6'
  const scope = 'synthetic-account-and-message'
  const html = renderChatMd(href)
  const host = document.createElement('div')
  host.innerHTML = html
  const card = host.querySelector('a')!
  card.dataset.chatCardLoaded = ''
  card.querySelector('strong')!.textContent = '已保存的日程'
  expect(stripChatCardSnapshotMarkers(host.innerHTML)).not.toContain('data-chat-card-loaded')
  applyChatCardSnapshots(host.innerHTML, scope, '历史快照')

  host.innerHTML = applyChatCardSnapshots(html, scope, '历史快照')
  expect(host.textContent).toContain('已保存的日程')
  expect(host.textContent).toContain('历史快照')
  expect(host.querySelector('a')?.hasAttribute('href')).toBe(false)
  expect(applyChatCardSnapshots(html, 'another-account', '历史快照')).not.toContain('已保存的日程')
})

it('联网来源忽略带凭据和非网页协议的地址', () => {
  const results = ['https://user:pass@example.test/', 'javascript:alert(1)', 'gugu://open-object/project/1', 'https://example.test/']
    .map(url => ({ url, title: '示例标题' }))
  expect(readChatSources({ results }).map(source => source.url)).toEqual(['https://example.test/'])
})

it('独立对象链接使用统一卡片，连续两张同组，句内和表格保留链接', () => {
  const markdown = [
    '打开 [项目甲](gugu://open-object/project/2) 查看进度。',
    '[项目甲](gugu://open-object/project/2 "当前在执行阶段")',
    '[笔记乙](gugu://open-object/note/4 "这是笔记摘录")',
    '',
    '| 对象 |',
    '| --- |',
    '| [画布丙](gugu://open-object/canvas/7) |',
  ].join('\n')
  const host = document.createElement('div')
  host.innerHTML = sanitizeChatHtml(renderChatMd(markdown))
  const links = [...host.querySelectorAll('a')]
  expect(links.map(link => link.getAttribute('href'))).toEqual([
    'gugu://open-object/project/2', 'gugu://open-object/project/2',
    'gugu://open-object/note/4', 'gugu://open-object/canvas/7',
  ])
  const group = host.querySelector('.chat-object-cards')!
  expect([...group.querySelectorAll('a')]).toEqual([links[1], links[2]])
  expect(links[1]?.textContent).toContain('当前在执行阶段')
  expect(links[2]?.textContent).toContain('这是笔记摘录')
})

it('独立文件卡显示路径中的文件名和扩展名', () => {
  const reference = `path-${btoa(JSON.stringify({ directoryId: 'personal', relativePath: 'docs/example.pdf', identity: '1.2.3' })).replace(/=+$/, '')}`
  const host = document.createElement('div')
  host.innerHTML = sanitizeChatHtml(renderChatMd(`[打开](gugu://open-object/file/${reference})`))
  const link = host.querySelector('a.chat-object-card')
  expect(link?.getAttribute('aria-label')).toBe('example.pdf')
  expect(link?.querySelector('.chat-object-file-icon svg path')).not.toBeNull()
  expect(link?.querySelector('.chat-object-card-heading')).toBeNull()
  expect(link?.textContent?.trim()).toBe('example.pdf')
})

it('文件卡按引用读取文件总大小，显示所在文件夹', async () => {
  const file = { directoryId: 'personal' as const, relativePath: 'docs/example.clip', identity: '1.2.3' }
  const reference = `path-${btoa(JSON.stringify(file)).replace(/=+$/, '')}`
  const contentUrl = vi.fn(() => '/synthetic-file')
  const fetchFile = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, {
    status: 206, headers: { 'Content-Range': 'bytes 0-0/2097152' },
  }))
  const host = document.createElement('div')
  const app = createApp(GuguChatMessageRow, {
    msg: { id: 1, role: 'ai', time: '', text: `gugu://open-object/file/${reference}` },
    sessionId: null, isGroupSession: false, interactionAnswerMode: 'composer',
    copiedId: null, voicePlayingId: null, voiceBars: [],
  }).use(i18n).provide(pathFileAccessKey, { ...pathFilesApi, contentUrl })
  app.mount(host)
  try {
    await vi.waitFor(() => expect(host.textContent).toContain('2.0 MB'))
    expect(host.textContent).toContain('docs')
    expect(contentUrl).toHaveBeenCalledExactlyOnceWith(file)
    expect(fetchFile).toHaveBeenCalledExactlyOnceWith('/synthetic-file', expect.objectContaining({ headers: { Range: 'bytes=0-0' } }))
  } finally {
    app.unmount()
    fetchFile.mockRestore()
  }
})

it('桌面对话中的系统图片引用显示文件名、大小和缩略图', async () => {
  const href = 'gugu://open-object/file/drop-synthetic'
  const systemReferenceUrl = (_reference: string, thumbnail?: boolean) =>
    thumbnail ? '/synthetic-file/thumbnail' : '/synthetic-file/metadata'
  const fetchFile = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
    name: '系统图片.png', size: 1024,
  }))
  const host = document.createElement('div')
  const app = createApp(GuguChatMessageRow, {
    msg: { id: 1, role: 'ai', time: '', text: href },
    sessionId: null, isGroupSession: false, interactionAnswerMode: 'composer',
    copiedId: null, voicePlayingId: null, voiceBars: [],
  }).use(i18n).provide(pathFileAccessKey, { ...pathFilesApi, systemReferenceUrl })
  app.mount(host)
  try {
    await vi.waitFor(() => expect(host.textContent).toContain('系统图片.png'))
    expect(host.textContent).toContain('1 KB')
    const card = host.querySelector('a.chat-object-card')
    expect(card?.getAttribute('href')).toBe(href)
    expect(card?.querySelector('img')?.getAttribute('src')).toBe('/synthetic-file/thumbnail')
  } finally {
    app.unmount()
    fetchFile.mockRestore()
  }
})

it('流式回复预读已完整的文件引用，最多同时查询五张卡片', async () => {
  const links = Array.from({ length: 7 }, (_, i) => `gugu://open-object/file/drop-synthetic-${i}`)
  const text = shallowRef(links.join('\n\n'))
  const replies: Array<() => void> = []
  const fetchFile = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => {
    replies.push(() => resolve(Response.json({ name: '合成文件.txt', size: 1 })))
  }))
  const host = document.createElement('div')
  const app = createApp({
    render: () => h(GuguChatCitations, { html: renderChatMd(text.value), text: text.value, presenting: true }),
  }).use(i18n).provide(pathFileAccessKey, {
    ...pathFilesApi, systemReferenceUrl: (id: string) => `/synthetic-file/${id}`,
  })
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  try {
    app.mount(host)
    await vi.waitFor(() => expect(fetchFile).toHaveBeenCalledTimes(5))
    expect(fetchFile.mock.calls.map(([url]) => url)).toEqual(links.slice(0, 5).map(link => `/synthetic-file/${link.split('/').at(-1)}`))
    replies[0]!()
    await vi.waitFor(() => expect(fetchFile).toHaveBeenCalledTimes(6))
    replies.slice(1).forEach(reply => reply())
    await nextTick()
    expect(fetchFile).toHaveBeenCalledTimes(6)
    text.value += '\n\n后续正文'
    await vi.waitFor(() => expect(fetchFile).toHaveBeenCalledTimes(7))
    expect(fetchFile.mock.calls[6]?.[0]).toBe('/synthetic-file/drop-synthetic-6')
  } finally {
    app.unmount()
    replies.forEach(reply => reply())
    fetchFile.mockRestore()
    vi.unstubAllGlobals()
  }
})

it('历史内置技能显示独立卡片，用户技能仍可打开', () => {
  const host = document.createElement('div')
  host.innerHTML = renderChatMd('gugu://open-skill/S9\n\ngugu://open-skill/U9')
  const [builtin, user] = host.querySelectorAll('[data-object-type="skill"]')
  expect(builtin?.textContent).toContain('项目管理')
  expect(builtin?.textContent).toContain('管理阶段与待办')
  expect(builtin?.textContent).not.toContain('S9')
  expect(builtin?.hasAttribute('href')).toBe(false)
  expect(user?.getAttribute('href')).toBe('gugu://open-skill/U9')
})

it('聊天历史里的独立裸地址显示卡片，行内和代码内容保持原文', () => {
  const file = `path-${btoa(JSON.stringify({ directoryId: 'personal', relativePath: 'docs/example.pdf', identity: '1.2.3' })).replace(/=+$/, '')}`
  const project = 'gugu://open-object/project/2'
  const markdown = [
    '下面每个链接单独一行：', '', `gugu://open-object/file/${file}`, '',
    project, 'gugu://open-object/note/22', '',
    `行内 ${project} 保留原文`, '', '```text', project, '```',
  ].join('\n')
  const host = document.createElement('div')
  host.innerHTML = sanitizeChatHtml(renderChatMd(markdown))
  const cards = [...host.querySelectorAll('a.chat-object-card')]
  expect(cards.map(card => card.getAttribute('aria-label'))).toEqual([
    'example.pdf', `${i18n.global.t('chatUi.objectCardTypes.project')} #2`, `${i18n.global.t('chatUi.objectCardTypes.note')} #22`,
  ])
  expect([...host.querySelectorAll('.chat-object-cards.is-multiple > a')]).toEqual(cards)
  expect(host.querySelector('pre')?.textContent).toContain(project)
  expect([...host.querySelectorAll('p')].some(paragraph => paragraph.textContent === `行内 ${project} 保留原文`)).toBe(true)
})

it('项目引用和看板共用逾期、今天截止和相对日期口径', () => {
  const today = new Date(2026, 10, 21, 12)
  expect(projectDeadlinePresentation({ deadline: '2026-11-19', status: 'active' }, today))
    .toEqual({ label: '逾期 2 天', urgent: true, overdue: true })
  expect(projectDeadlinePresentation({ deadline: '2026-11-21', status: 'active' }, today).label).toBe('今天截止')
  expect(projectDeadlinePresentation({ deadline: '2026-11-28', status: 'pending' }, today).label).toBe('7天后')
  expect(projectDeadlinePresentation({ deadline: '2026-11-19', status: 'done' }, today))
    .toEqual({ label: '11/19', urgent: false, overdue: false })
})

it('项目卡展示授权查询返回的名称、阶段、截止日和进度，缺失项目仍保留引用', async () => {
  const get = vi.fn<typeof webProjectAccess.get>().mockResolvedValueOnce({
    id: 2, name: '示例项目 <验收>', status: 'active', client: null, startDate: null, deadline: '2026-11-25',
    color: 'linear-gradient(135deg,#7ab8a8,#7ab8c8)', progress: 0, currentStage: 's0', archived: false, version: 1, createdAt: '2026-11-21',
    stages: [{ key: 's0', label: '交付阶段', todos: [
      { id: 'a', text: '已核对', done: true }, { id: 'b', text: '待验收', done: false },
    ] }],
  }).mockRejectedValueOnce(new Error('项目不存在'))
  const host = document.createElement('div')
  const msg = { id: 1, role: 'ai', time: '', text: 'gugu://open-object/project/2\ngugu://open-object/project/7\ngugu://open-object/project/2' }
  const app = createApp(GuguChatMessageRow, {
    msg, sessionId: null, isGroupSession: false, interactionAnswerMode: 'composer', copiedId: null,
    voicePlayingId: null, voiceBars: [],
  }).use(i18n).provide(projectAccessKey, { ...webProjectAccess, get })
  app.mount(host)
  try {
    await vi.waitFor(() => expect(host.querySelectorAll('progress')).toHaveLength(2))
    expect(get.mock.calls).toEqual([[2], [7]])
    expect(host.querySelector('.chat-object-card-title')?.textContent).toBe('示例项目 <验收>')
    expect(host.textContent).toContain('交付阶段')
    expect(host.textContent).toContain(i18n.global.t('calendar.types.deadline'))
    expect(host.querySelector('progress')?.value).toBe(50)
    expect(host.querySelector('a[href="gugu://open-object/project/7"] progress')).toBeNull()
    expect(host.querySelector('.chat-project-status')?.textContent).toBe(i18n.global.t('projects.inProgress'))
    expect(host.querySelector('.chat-project-stage-status')).toBeNull()
    expect(host.querySelector('progress')?.style.getPropertyValue('--chat-project-fill')).toBe('linear-gradient(135deg,#7ab8a8,#7ab8c8)')
    expect(host.querySelector('details')).toBeNull()
  } finally {
    app.unmount()
  }
})

it('来源图标只向固定服务发送域名，局域网地址不加载', () => {
  const sources = readChatSources({ results: [
    { url: 'https://news.example.org/one?private=1#section', title: '示例甲', site_icon: 'https://static.example.org/logo.png' },
    { url: 'https://127.0.0.1/two', title: '示例乙' },
    { url: 'https://news.local/one', title: '本地示例' },
  ] })
  expect(sources.map(item => item.icon)).toEqual([
    'https://icons.duckduckgo.com/ip3/news.example.org.ico', undefined, undefined,
  ])
})

it('历史回复只读取当前轮搜索详情，来源不会串到其他轮', async () => {
  const reference = { kind: 'timeline' as const, messageId: 10, index: 1 }
  const detail = vi.fn(async () => ({ toolResult: { results: [{ url: 'https://example.test/', title: '示例来源' }] } }))
  const reply: ChatMessage = { id: 3, role: 'ai', runId: 'active', text: '[示例](https://example.test/)', time: '' }
  const tool: ChatMessage = {
    id: 1, role: 'tool', runId: 'active', text: '', time: '', toolName: 'web_search', toolStatus: 'success',
    toolDetailsAvailable: true, _toolDetailsSource: reference,
  }
  const messages = [{ ...tool, id: 2, runId: 'older', _toolDetailsSource: { ...reference, index: 0 } }, tool, reply]
  const app = createApp({}).provide(chatToolDetailsKey, detail)
  const scope = effectScope()
  try {
    const sourcesFor = app.runWithContext(() => scope.run(() => useChatSources(() => 7, () => messages, () => [reply])))!
    await vi.waitFor(() => expect(sourcesFor(reply, 2)?.[0]?.title).toBe('示例来源'))
    expect(detail).toHaveBeenCalledExactlyOnceWith(7, reference)
    expect(sourcesFor({ ...reply, runId: 'unrelated' }, 2)).toBeUndefined()
  } finally {
    scope.stop()
  }
})

it('从历史响应恢复只含引用的消息后，可从消息行打开引用', async () => {
  const reference: ChatReference = { type: 'file', id: 'drop-example', label: '历史原件.txt' }
  const [msg] = mapSessionMessageDelta({
    messages: [{ id: 42, role: 'user', content: '', references: [reference], createdAt: '2026-01-01T00:00:00Z' }],
  }, () => 1, () => ({ role: 'user' }))
  const onReferenceClick = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(GuguChatMessageRow, {
    msg: msg!, sessionId: 17, isGroupSession: false, interactionAnswerMode: 'composer',
    copiedId: null, voicePlayingId: null, voiceBars: [], onReferenceClick,
  }).use(i18n)
  app.mount(host)
  try {
    await nextTick()
    const chip = host.querySelector<HTMLElement>('.chat-reference')
    expect(chip?.textContent).toBe(reference.label)
    chip?.click()
    expect(onReferenceClick).toHaveBeenCalledExactlyOnceWith(reference)
  } finally {
    app.unmount()
    host.remove()
  }
})
