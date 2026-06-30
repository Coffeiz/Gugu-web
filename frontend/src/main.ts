import { runClientVersionGate } from '@/utils/clientVersionGate'
runClientVersionGate()   // 新版本上线 → 先清掉跨版本过期的客户端状态（保留登录），再启动

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ArcoVue from '@arco-design/web-vue'
import ArcoVueIcon from '@arco-design/web-vue/es/icon'
import '@arco-design/web-vue/dist/arco.css'
import '@/assets/styles/global.css'

import App from './App.vue'
import router from './router'
import DatePicker from '@/components/common/DatePicker.vue'
import DateSpanPicker from '@/components/common/DateSpanPicker.vue'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(ArcoVue)
app.use(ArcoVueIcon)

app.component('DatePicker', DatePicker)
app.component('DateSpanPicker', DateSpanPicker)

app.mount('#app')
