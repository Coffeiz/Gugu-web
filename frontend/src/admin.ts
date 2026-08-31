import { runClientVersionGate } from '@/utils/clientVersionGate'
runClientVersionGate()   // 新版本上线 → 先清掉跨版本过期的客户端状态（保留登录），再启动

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@/assets/styles/global.css'

import AdminApp from './AdminApp.vue'
import router from './router/admin'
import { installEnterDirective } from '@/directives/enter'
import { initializeTheme } from '@/composables/useTheme'
import Icon from '@/components/common/Icon.vue'
import { i18n } from '@/i18n'

initializeTheme('dark', 'glass')

const app = createApp(AdminApp)

app.use(createPinia())
app.use(i18n)
app.use(router)
app.component('Icon', Icon)
installEnterDirective(app)

app.mount('#app')
