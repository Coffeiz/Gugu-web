import { computed } from 'vue'
import { tokenCatalog, type DesignToken } from '../data/tokenCatalog'

export function useDesignTokens() {
  const tokens = computed(() => tokenCatalog)
  function valueOf(token: DesignToken): string {
    return getComputedStyle(document.documentElement).getPropertyValue(token.variable).trim() || '未定义'
  }
  async function copyToken(token: DesignToken) {
    const value = valueOf(token)
    await navigator.clipboard?.writeText(`${token.variable}: ${value}`)
  }
  return { tokens, valueOf, copyToken }
}
