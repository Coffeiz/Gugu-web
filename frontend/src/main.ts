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
initializeButtonFeedback()
setupInteractionRuntime()

const app = createApp(App)

app.use(createPinia())
app.use(i18n)
app.use(router)
app.use(ArcoVue)
installEnterDirective(app)

app.component('DatePicker', DatePicker)
app.component('DateSpanPicker', DateSpanPicker)
app.component('Icon', Icon)

app.mount('#app')
installOverlayScrollbars()
