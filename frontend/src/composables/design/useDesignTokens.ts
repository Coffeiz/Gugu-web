import { computed } from 'vue'
import { tokenCatalog, type DesignToken } from '@/views/Design/data/tokenCatalog'
import { showAppError, showAppSuccess } from '@/composables/core/useAppToast'

export function useDesignTokens() {
  const tokens = computed(() => tokenCatalog)
  function valueOf(token: DesignToken): string {
    return getComputedStyle(document.documentElement).getPropertyValue(token.variable).trim() || '未定义'
  }
  async function copyToken(token: DesignToken): Promise<boolean> {
    const value = valueOf(token)
    const text = `${token.variable}: ${value}`
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) throw new Error('clipboard unavailable')
      }
      showAppSuccess(`已复制 ${token.variable}`)
      return true
    } catch {
      showAppError('复制失败，请检查浏览器剪贴板权限')
      return false
    }
  }
  return { tokens, valueOf, copyToken }
}
