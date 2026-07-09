import type { App, Directive, DirectiveBinding } from 'vue'

/**
 * v-enter="handler"           输入框按 Enter 时调用 handler(event)。
 * v-enter.prevent="handler"   同上 + 阻止默认行为（替代原生 @keydown.enter.prevent）。
 * v-enter.exact="handler"     同上 + 要求没按 ctrl/alt/shift/meta（配合 Shift+Enter 换行场景，如聊天输入框）。
 *
 * 目的：中文输入法下敲回车确认候选词，浏览器也会派发一次 keydown Enter；组件若自己判断
 * 「回车=提交/确认」，很容易把候选词选中误当成真正回车、直接触发提交（候选词还没选完就被抢发）。
 * 每个输入框各自记 isComposing 状态很容易漏掉，统一走这个指令，从根上避免、以后新输入框
 * 直接用即可，不用再单独处理 IME。
 */
interface EnterEl extends HTMLElement {
  __enterBinding__?: DirectiveBinding
  __enterHandler__?: (e: Event) => void
}

function onKeydown(e: KeyboardEvent, el: EnterEl) {
  if (e.key !== 'Enter') return
  // isComposing 是标准判据；keyCode 229 是部分旧浏览器/输入法在组合过程中给的兼容码，双保险
  if (e.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229) return
  const binding = el.__enterBinding__
  if (!binding) return
  if (binding.modifiers.exact && (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) return
  if (binding.modifiers.prevent) e.preventDefault()
  const handler = binding.value
  if (typeof handler === 'function') handler(e)
}

export const vEnter: Directive<EnterEl, (e: KeyboardEvent) => void> = {
  mounted(el, binding) {
    el.__enterBinding__ = binding
    el.__enterHandler__ = (e) => onKeydown(e as KeyboardEvent, el)
    el.addEventListener('keydown', el.__enterHandler__)
  },
  updated(el, binding) {
    el.__enterBinding__ = binding   // 闭包里的 handler 靠这个引用拿最新 value，避免绑定时的值被闭包锁死
  },
  beforeUnmount(el) {
    if (el.__enterHandler__) el.removeEventListener('keydown', el.__enterHandler__)
  },
}

export function installEnterDirective(app: App) {
  app.directive('enter', vEnter)
}
