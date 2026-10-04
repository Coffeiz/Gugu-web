import { createApp, h, nextTick, ref, withDirectives } from 'vue'
import { describe, expect, it } from 'vitest'
import { vMindPreview } from './mindPreview'

function preview(checked: boolean, text = '整理需求') {
  return `<ul class="np-tasks"><li class="${checked ? 'done' : ''}"><input type="checkbox" data-task-idx="0"${checked ? ' checked' : ''}><span>${text}</span></li></ul>`
}

describe('Mind 预览待办更新', () => {
  it('乐观勾选与失败回滚复用 checkbox 节点，使标准过渡能持续播放', async () => {
    const html = ref(preview(false))
    const host = document.createElement('div')
    document.body.append(host)
    const app = createApp({ render: () => withDirectives(h('article'), [[vMindPreview, html.value]]) })
    app.mount(host)
    try {
      const checkbox = host.querySelector<HTMLInputElement>('input')!
      html.value = preview(true)
      await nextTick()
      expect(host.querySelector('input')).toBe(checkbox)
      expect(checkbox.checked).toBe(true)
      expect(checkbox.parentElement?.classList.contains('done')).toBe(true)
      // 失败回滚沿同一个节点反向过渡。
      html.value = preview(false)
      await nextTick()
      expect(host.querySelector('input')).toBe(checkbox)
      expect(checkbox.checked).toBe(false)
      expect(checkbox.parentElement?.classList.contains('done')).toBe(false)
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it('文字变化重新渲染，并继续消毒 HTML', async () => {
    const html = ref(preview(false))
    const host = document.createElement('div')
    const app = createApp({ render: () => withDirectives(h('article'), [[vMindPreview, html.value]]) })
    app.mount(host)
    try {
      const original = host.querySelector('input')
      html.value = preview(true, '对齐设计稿<script>window.bad = true</script>')
      await nextTick()
      expect(host.querySelector('input')).not.toBe(original)
      expect(host.querySelector<HTMLInputElement>('input')?.checked).toBe(true)
      expect(host.textContent).toBe('对齐设计稿')
      expect(host.querySelector('script')).toBeNull()
    } finally {
      app.unmount()
    }
  })
})
