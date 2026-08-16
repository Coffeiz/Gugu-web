import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './styles/base.css'
import { saveBootstrap } from './services/gugu'

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data) return
  if (window.opener && event.source !== window.opener) return

  if (data.type === 'gugu:loopscope-bootstrap-request') {
    ;(event.source as WindowProxy | null)?.postMessage({ type: 'loopscope:ready' }, event.origin)
    return
  }
  if (data.type !== 'loopscope:gugu-bootstrap') return
  if (typeof data.apiBase !== 'string' || typeof data.token !== 'string') return
  saveBootstrap({ apiBase: data.apiBase, token: data.token })
})

if (window.opener) {
  window.opener.postMessage({ type: 'loopscope:ready' }, '*')
}

createApp(App).use(router).mount('#app')
