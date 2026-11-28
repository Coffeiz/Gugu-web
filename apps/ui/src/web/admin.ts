import { pathFileAccessKey } from '@/services/pathFileAccess'
import { pathFilesApi } from '@/services/api'
import { scheduleAccessKey } from '@/services/scheduleAccess'
import { webScheduleAccess } from './schedules/access'
import { projectAccessKey } from '@/api/projects'
import { webProjectAccess } from './projects/access'
import { mindAccessKey } from '@/services/mindAccess'
import { webMindAccess } from './mind/access'
import { runClientVersionGate } from '@/utils/clientVersionGate'
runClientVersionGate()   // 新版本上线 → 先清掉跨版本过期的客户端状态（保留登录），再启动

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@/assets/styles/global.css'

import AdminApp from './AdminApp.vue'
import router from './router/admin'
import { installEnterDirective } from '@/directives/enter'
import { initializeTheme } from '@/composables/core/useTheme'
import Icon from '@/components/common/icons/Icon.vue'
import { i18n } from '@/i18n'

initializeTheme('dark', 'glass')

const app = createApp(AdminApp)

app.provide(pathFileAccessKey, pathFilesApi)
app.provide(scheduleAccessKey, webScheduleAccess)
app.provide(projectAccessKey, webProjectAccess)
app.provide(mindAccessKey, webMindAccess)
app.use(createPinia())
app.use(i18n)
app.use(router)
app.component('Icon', Icon)
installEnterDirective(app)

app.mount('#app')
