import { runClientVersionGate } from '@/utils/clientVersionGate'
runClientVersionGate()   // 新版本上线 → 先清掉跨版本过期的客户端状态（保留登录），再启动

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@/assets/styles/global.css'

import AdminApp from './AdminApp.vue'
import router from './router/admin.js'

const app = createApp(AdminApp)

app.use(createPinia())
app.use(router)

app.mount('#app')
