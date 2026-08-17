import { createRouter, createWebHistory } from 'vue-router'
import PlaygroundView from './views/PlaygroundView.vue'
import TokensView from './views/TokensView.vue'
import ChangelogView from './views/ChangelogView.vue'
import SettingsView from './views/SettingsView.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: PlaygroundView },
    { path: '/tokens', component: TokensView },
    { path: '/changelog', component: ChangelogView },
    { path: '/settings', component: SettingsView },
  ],
})
