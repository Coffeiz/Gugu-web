// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'
import { mindAccessKey } from '@/services/mindAccess'
import { webMindAccess } from '@web/mind/access'
import { projectAccessKey } from '@/api/projects'
import { webProjectAccess } from '@web/projects/access'
import GuguChatComposer from '@/components/common/gugu-chat/GuguChatComposer.vue'
import { byokApi } from '@/services/api'
import { createWebChatModelCatalog } from '@web/chat/modelCatalog'
import { chatModelCatalogKey, type ChatModelCatalog } from '@/components/common/gugu-chat/chatPresentationAccess'
import GuguChatMessageRow from '@/components/common/gugu-chat/GuguChatMessageRow.vue'
import { mapSessionMessageDelta } from '@/components/common/gugu-chat/composables/sessionMessageSync'
import { findClickedChatReference, type ChatReference } from '@/components/common/gugu-chat/chatTypes'
import { renderChatMd } from '@/components/common/gugu-chat/markdown'
import { sanitizeChatHtml } from '@/utils/markdown'
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
