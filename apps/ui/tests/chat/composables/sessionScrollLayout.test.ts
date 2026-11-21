import { describe, expect, it } from 'vitest'
import { hasPendingMessageMarkdown } from '@/components/common/gugu-chat/composables/sessionScrollLayout'

describe('切换会话时当前虚拟窗口的 Markdown 渲染闸门', () => {
  it('当前窗口的 Markdown/Mermaid 尚未完成时继续等待', () => {
    const list = document.createElement('div')
    list.innerHTML = '<div class="msg-virtual-row"><div class="msg ai"><div class="msg-bubble md-body"><div class="md-view" data-mermaid-ready="false"></div></div></div></div>'

    expect(hasPendingMessageMarkdown(list)).toBe(true)
  })

  it('当前窗口的用户与 AI 气泡都准备完成后才允许解除等待', () => {
    const list = document.createElement('div')
    list.innerHTML = [
      '<div class="msg-virtual-row"><div class="msg ai"><div class="msg-bubble md-body"><div class="md-view" data-mermaid-ready="true"></div></div></div></div>',
      '<div class="msg-virtual-row"><div class="msg user"><div class="msg-bubble user-md"><div class="md-view" data-mermaid-ready="true"></div></div></div></div>',
    ].join('')

    expect(hasPendingMessageMarkdown(list)).toBe(false)
  })

  it('不把虚拟窗口外或非 Markdown 气泡纳入等待条件', () => {
    const list = document.createElement('div')
    list.innerHTML = [
      '<div class="msg-virtual-row"><div class="msg tool"><div class="msg-bubble">tool</div></div></div>',
      '<div class="msg-virtual-row"><div class="msg ai"><div class="msg-bubble md-body"><div class="md-view" data-mermaid-ready="true"></div></div></div></div>',
      '<div class="offscreen"><div class="msg-bubble md-body"><div class="md-view" data-mermaid-ready="false"></div></div></div>',
    ].join('')

    expect(hasPendingMessageMarkdown(list)).toBe(false)
  })
})
