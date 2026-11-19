import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ArcoVue from '@arco-design/web-vue'
import '@arco-design/web-vue/dist/arco.css'
import '@/assets/styles/global.css'
import DesktopWorkbench from '../../../desktop/src/ui/shell/index.vue'
import { i18n } from '@/i18n'
import { setupInteractionRuntime } from '@/interaction/runtime/setup'
import { initializeDesktopTheme } from '@/composables/core/useTheme'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    // 普通页面由桌面壳层渲染；笔记和画布在路由提交前解析异步组件。
    { path: '/', name: 'home', components: {} },
    ...['projects', 'calendar', 'schedules', 'files', 'terminals', 'skills', 'mcp', 'contacts', 'team', 'notifications']
      .map(section => ({ path: `/${section}`, name: section, components: {} })),
    { path: '/notes', name: 'notes', component: () => import('@/views/Mind/NotesThreePaneView.vue') },
    { path: '/canvases', name: 'canvases', component: () => import('@/views/Mind/CanvasView.vue') },
    { path: '/mind/notes', redirect: to => ({ path: '/notes', query: to.query, hash: to.hash }) },
    { path: '/mind/canvases', redirect: to => ({ path: '/canvases', query: to.query, hash: to.hash }) },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

document.documentElement.dataset.desktopShell = 'true'
document.documentElement.style.background = 'transparent'
document.body.style.background = 'transparent'
initializeDesktopTheme()
setupInteractionRuntime()
createApp(DesktopWorkbench).use(createPinia()).use(i18n).use(ArcoVue).use(router).mount('#app')
