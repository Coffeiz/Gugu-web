import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@/assets/styles/global.css'

import AdminApp from './AdminApp.vue'
import router from './router/admin.js'

const app = createApp(AdminApp)

app.use(createPinia())
app.use(router)

app.mount('#app')
