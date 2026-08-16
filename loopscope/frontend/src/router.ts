import { createRouter, createWebHistory } from 'vue-router'
import PlaygroundView from './views/PlaygroundView.vue'
import MonitorView from './views/MonitorView.vue'
import TokensView from './views/TokensView.vue'
import SettingsView from './views/SettingsView.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: PlaygroundView },
    { path: '/sessions/:sessionId/monitor', component: MonitorView },
    { path: '/tokens', component: TokensView },
    { path: '/settings', component: SettingsView },
  ],
})
