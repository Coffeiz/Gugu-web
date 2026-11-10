import { createApp } from 'vue'
import '@/assets/styles/global.css'
import DesktopWorkbench from './DesktopWorkbench.vue'

document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
createApp(DesktopWorkbench).mount('#app')
