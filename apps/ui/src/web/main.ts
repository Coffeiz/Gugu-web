import { installMailLinks, openMailComposer } from '@/api/mailLinks'
import { pathFileAccessKey } from '@/services/pathFileAccess'
import { pathFilesApi } from '@/services/api'
import { scheduleAccessKey } from '@/services/scheduleAccess'
import { webScheduleAccess } from './schedules/access'
import { projectAccessKey } from '@/api/projects'
import { webProjectAccess } from './projects/access'
import { mindAccessKey } from '@/services/mindAccess'
import { webMindAccess } from './mind/access'
import { searchAccessKey } from '@/services/searchAccess'
import { webSearchAccess } from './search/access'
import { mailAccessKey } from '@/api/mail'
import { webMailAccess } from './mailAccess'
import { runClientVersionGate } from '@/utils/clientVersionGate'
runClientVersionGate()   // 新版本上线 → 先清掉跨版本过期的客户端状态（保留登录），再启动

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ArcoVue from '@arco-design/web-vue'
import '@arco-design/web-vue/dist/arco.css'
import '@/assets/styles/global.css'
import { setupInteractionRuntime } from '@/interaction/runtime/setup'

import App from './App.vue'
import router from './router'
import DatePicker from '@/components/common/controls/DatePicker.vue'
import DateSpanPicker from '@/components/common/controls/DateSpanPicker.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { installEnterDirective } from '@/directives/enter'
import { initializeTheme } from '@/composables/core/useTheme'
import { initializeButtonFeedback } from '@/composables/core/useButtonFeedback'
import { installOverlayScrollbars } from '@/utils/overlayScrollbars'
import { i18n } from '@/i18n'

initializeTheme()
// 横幅在主题初始化后打印，并跟随服务端偏好落地/用户切主题重打
import('@/utils/consoleBanner').then(({ startConsoleBanner }) => startConsoleBanner())
initializeButtonFeedback()
setupInteractionRuntime()

const app = createApp(App)

app.provide(searchAccessKey, webSearchAccess)
app.provide(mailAccessKey, webMailAccess)
app.provide(pathFileAccessKey, pathFilesApi)
app.provide(scheduleAccessKey, webScheduleAccess)
app.provide(projectAccessKey, webProjectAccess)
app.provide(mindAccessKey, webMindAccess)
app.use(createPinia())
app.use(i18n)
app.use(router)
installMailLinks(to => openMailComposer(router, to))
app.use(ArcoVue)
installEnterDirective(app)

app.component('DatePicker', DatePicker)
app.component('DateSpanPicker', DateSpanPicker)
app.component('Icon', Icon)

app.mount('#app')
installOverlayScrollbars()
