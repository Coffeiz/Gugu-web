// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'

import { chatTextFromDoc } from './chatDocText'
import { parseChatClipboardText, pastePlainTextClipboard } from './chatPaste'
import { mindExtensions, type MindDocNode } from '@/composables/mind/useMindEditor'

function clipboardEvent(types: string[], values: Record<string, string>): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { types, getData: (type: string) => values[type] ?? '' },
  })
  return event as ClipboardEvent
}

function createChatEditor(): Editor {
  let editor: Editor
  editor = new Editor({
    element: document.createElement('div'),
    extensions: mindExtensions(),
    content: '',
    enableInputRules: false,
    enablePasteRules: false,
    editorProps: {
      clipboardTextParser: parseChatClipboardText,
      handlePaste: (view, event) => {
        // 与聊天组件一致：附件处理先运行，已消费的事件不再插入文本。
        if (event.defaultPrevented) return true
        return pastePlainTextClipboard(event, view)
      },
    },
  })
  return editor
}

describe('聊天纯文本粘贴', () => {
  it('富文本剪贴板走原生 paste 事件时插入 text/plain，不带 HTML 样式', () => {
    const markdown = '# 文档\n\n## 19. 最终定位\n\n**保留 Markdown 字面标记**'
    const event = clipboardEvent(['text/html', 'text/plain'], {
      'text/html': '<h1>文档</h1><h2>19. 最终定位</h2><p><strong>富文本粗体</strong></p>',
      'text/plain': markdown,
    })
    const editor = createChatEditor()

    try {
      editor.view.dom.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
      expect(chatTextFromDoc(editor.getJSON() as MindDocNode)).toBe(markdown)
      const marks: string[] = []
      editor.state.doc.descendants(node => {
        if (node.isText) marks.push(...node.marks.map(mark => mark.type.name))
      })
      expect(marks).toEqual([])
    } finally {
      editor.destroy()
    }
  })

  it('长文章粘贴完整保留每一行和连续空行', () => {
    const article = Array.from({ length: 400 }, (_, index) =>
      `## ${index + 1}. 标题\n\n正文 **原样标记** 与普通文本。\n- 列表项目\n\n---`,
    ).join('\n\n')
    const event = clipboardEvent(['text/html', 'text/plain'], {
      'text/html': '<h2>富文本标题</h2>',
      'text/plain': article,
    })
    const editor = createChatEditor()

    try {
      editor.view.dom.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
      expect(chatTextFromDoc(editor.getJSON() as MindDocNode)).toBe(article)
    } finally {
      editor.destroy()
    }
  })

  it('纯文本剪贴板同样完整插入，不依赖 HTML MIME 类型', () => {
    const plain = '第一行\n\n## 第二行'
    const event = clipboardEvent(['text/plain'], { 'text/plain': plain })
    const editor = createChatEditor()

    try {
      editor.view.dom.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
      expect(chatTextFromDoc(editor.getJSON() as MindDocNode)).toBe(plain)
    } finally {
      editor.destroy()
    }
  })
})
