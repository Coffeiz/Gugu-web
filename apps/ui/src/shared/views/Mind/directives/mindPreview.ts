import type { ObjectDirective } from 'vue'
import { sanitizeHtml } from '@/utils/markdown'

const taskSelector = '.np-tasks input[type="checkbox"][data-task-idx]'
const rendered = new WeakMap<HTMLElement, { html: string; structure: string }>()

/** 只剥离待办状态以比较正文结构，文字、引用、属性或任务顺序变化仍重建正文。 */
function parsePreview(html: string) {
  const template = document.createElement('template')
  template.innerHTML = sanitizeHtml(html)
  const tasks = [...template.content.querySelectorAll<HTMLInputElement>(taskSelector)]
  const checked = tasks.map(task => task.checked)
  for (const task of tasks) {
    task.removeAttribute('checked')
    task.parentElement?.classList.remove('done')
  }
  const structure = template.innerHTML
  tasks.forEach((task, index) => {
    task.toggleAttribute('checked', checked[index])
    task.checked = checked[index]
    task.parentElement?.classList.toggle('done', checked[index])
  })
  return { template, structure, checked }
}

function updatePreview(el: HTMLElement, html: string) {
  const previous = rendered.get(el)
  if (previous?.html === html) return
  const next = parsePreview(html)
  const existing = [...el.querySelectorAll<HTMLInputElement>(taskSelector)]
  if (previous?.structure === next.structure && existing.length === next.checked.length) {
    // 保留已有节点：乐观勾选、服务端确认和失败回滚都能使用标准 checkbox CSS 过渡。
    existing.forEach((task, index) => {
      task.toggleAttribute('checked', next.checked[index])
      task.checked = next.checked[index]
      task.parentElement?.classList.toggle('done', next.checked[index])
    })
  } else {
    el.replaceChildren(next.template.content)
  }
  rendered.set(el, { html, structure: next.structure })
}

/** Mind 预览的唯一 DOM 更新入口；输入 HTML 始终经过公共消毒出口。 */
export const vMindPreview: ObjectDirective<HTMLElement, string> = {
  beforeMount: (el, binding) => updatePreview(el, binding.value),
  beforeUpdate: (el, binding) => updatePreview(el, binding.value),
  unmounted: el => rendered.delete(el),
}
