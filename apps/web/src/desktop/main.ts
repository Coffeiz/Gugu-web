import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ArcoVue from '@arco-design/web-vue'
import '@arco-design/web-vue/dist/arco.css'
import '@/assets/styles/global.css'
import DesktopWorkbench from '../../../desktop/src/ui/DesktopWorkbench.vue'
import { i18n } from '@/i18n'
import { setupInteractionRuntime } from '@/interaction/runtime/setup'

document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
document.documentElement.dataset.desktopShell = 'true'
document.documentElement.style.background = 'transparent'
document.body.style.background = 'transparent'
setupInteractionRuntime()
createApp(DesktopWorkbench).use(createPinia()).use(i18n).use(ArcoVue).mount('#app')
