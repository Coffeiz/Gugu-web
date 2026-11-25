import { createApp } from 'vue'
import '@/assets/styles/global.css'
import { i18n } from '@/i18n'
import { initializeDesktopTheme } from '@/composables/core/useTheme'
import { chatFab } from './bridge'
import DesktopChatFabWindow from './DesktopChatFabWindow.vue'

export function mountDesktopChatFab() {
  initializeDesktopTheme()
  createApp(DesktopChatFabWindow).use(i18n).mount('#app')
  chatFab?.gesture('ready')
}
