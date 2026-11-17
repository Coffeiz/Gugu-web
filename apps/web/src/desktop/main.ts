import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ArcoVue from '@arco-design/web-vue'
import '@arco-design/web-vue/dist/arco.css'
import '@/assets/styles/global.css'
import DesktopWorkbench from '../../../desktop/src/ui/shell/index.vue'
import { i18n } from '@/i18n'
import { setupInteractionRuntime } from '@/interaction/runtime/setup'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/notes', component: () => import('@/views/Mind/NotesThreePaneView.vue') },
    { path: '/canvases', component: () => import('@/views/Mind/CanvasView.vue') },
    { path: '/mind/notes', redirect: to => ({ path: '/notes', query: to.query, hash: to.hash }) },
    { path: '/mind/canvases', redirect: to => ({ path: '/canvases', query: to.query, hash: to.hash }) },
    { path: '/:pathMatch(.*)*', component: () => import('../../../desktop/src/ui/workbench/index.vue') },
  ],
})

document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
document.documentElement.dataset.desktopShell = 'true'
document.documentElement.style.background = 'transparent'
document.body.style.background = 'transparent'
setupInteractionRuntime()
createApp(DesktopWorkbench).use(createPinia()).use(i18n).use(ArcoVue).use(router).mount('#app')
