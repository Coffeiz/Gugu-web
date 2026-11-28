import { ref, watch } from 'vue'

export function useFileViewMode(surface: 'library' | 'project-editor') {
  const key = `gugu-file-view-mode-${surface}`
  const mode = ref<'grid' | 'list'>('grid')
  try {
    if (window.localStorage.getItem(key) === 'list') mode.value = 'list'
  } catch { /* 偏好不可用时使用网格。 */ }

  watch(mode, value => {
    try { window.localStorage.setItem(key, value) }
    catch { /* 偏好不可用时仍可在当前页面切换。 */ }
  }, { flush: 'sync' })
  return mode
}
