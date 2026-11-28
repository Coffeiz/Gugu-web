import { expect, it } from 'vitest'
import { renderedSelectionContent, selectionMessageText } from '@/components/common/selection/selectionDraft'

const reference = { type: 'file' as const, id: 'path-synthetic', label: '提出修改 · 配置.yml' }

it('历史气泡只隐藏早期追加的内部选区上下文', () => {
  const text = '@提出修改 · 配置.yml 请精简\n\n修改引用 · 提出修改 · 配置.yml · 配置.yml:1:1–2:3\n'
    + '修改前重新读取来源并核对原文与范围。未保存或无法核对时，请先询问我。\n\n```\n内部引用原文\n```'
  expect(selectionMessageText(text, [reference])).toBe('@提出修改 · 配置.yml 请精简')
  expect(selectionMessageText(text)).toBe(text)
})

it('新消息的选区元数据不影响用户正文', () => {
  const text = '请精简这一段\n\n```\n用户自己输入的代码\n```'
  const selection = { location: '配置.yml', content: '已渲染片段', rendered: true }
  expect(selectionMessageText(text, [{ ...reference, selection }])).toBe(text)
})

it('阅读态选区保留选中的胶囊身份及前后文本', () => {
  const root = document.createElement('article')
  root.innerHTML = '<p>项目引用：<span class="mind-ref" data-ref-type="project" data-ref-id="76"><span class="mind-ref-label">示例项目</span></span> 后文</p>'
    + '<p><span class="mind-ref" data-ref-type="event" data-ref-id="80">未选日程</span></p>'
  const line = root.firstElementChild!
  const range = document.createRange()
  range.selectNodeContents(line)
  expect(renderedSelectionContent(root, range)).toBe('项目引用：[[project:76|示例项目]] 后文')

  const label = root.querySelector('.mind-ref-label')!.firstChild!
  range.setStart(label, 1)
  range.setEnd(label, 3)
  expect(renderedSelectionContent(root, range)).toBe('[[project:76|示例项目]]')

  range.setStart(line.firstChild!, 0)
  range.setEndBefore(root.querySelector('.mind-ref')!)
  expect(renderedSelectionContent(root, range)).toBe('项目引用：')
})
