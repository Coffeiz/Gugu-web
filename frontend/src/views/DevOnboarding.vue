<template>
  <div class="onb-dev">
    <h2>新手引导 · Demo 控制面板</h2>
    <p class="hint">作用于<strong>当前登录用户自己</strong>。改完不必重注册，直接在这里触发 / 重置 / 重建。
      访问路径 <code>/dev/onboarding</code>。</p>

    <div class="row">
      <button @click="refresh">刷新状态</button>
      <button @click="reset">重置已读标记（气泡可重弹）</button>
      <button class="warn" @click="reseed">重新播种引导项目（删旧建新）</button>
    </div>

    <div class="row">
      <span class="lbl">立刻预览气泡（不改 once）：</span>
      <button @click="fire('welcome')">欢迎(01)</button>
      <button @click="fire('guide')">引导(02)</button>
      <button @click="fire('hint:file_lib')">文件库(07)</button>
      <button @click="fire('hint:im_bind')">绑定 IM(07)</button>
      <button @click="fire('lookback')">回头看(08)</button>
    </div>

    <p v-if="msg" class="msg">{{ msg }}</p>

    <h3>当前状态</h3>
    <pre class="state">{{ stateText }}</pre>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { onboardingApi } from '@/services/api'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const state = ref(null)
const msg = ref('')
const stateText = computed(() => state.value ? JSON.stringify(state.value, null, 2) : '加载中…')

async function refresh() {
  try { state.value = await onboardingApi.getState() } catch (e) { msg.value = '拉取状态失败' }
}
async function reset() {
  await onboardingApi.devReset(); msg.value = '已重置已读标记'; refresh()
}
async function reseed() {
  msg.value = '重新播种中…'
  const r = await onboardingApi.devReseed()
  state.value = r.state; msg.value = '已重新播种引导项目（去项目面板看看）'
}
async function fire(key) {
  const { text } = await onboardingApi.devFire(key)
  if (text) { ui.pushNotification({ title: '', content: text, bubble: true, persist: false, gugu: true }); msg.value = `已弹：${key}` }
  else msg.value = `${key} 无文案`
}

onMounted(refresh)
</script>

<style scoped>
.onb-dev { max-width: 760px; margin: 0 auto; padding: 28px 24px; color: var(--text-primary, #2a2a3a); }
h2 { margin: 0 0 6px; }
.hint { font-size: 13px; color: var(--text-secondary, #6b6b80); line-height: 1.6; margin: 0 0 18px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.lbl { font-size: 13px; color: var(--text-secondary, #6b6b80); }
button { padding: 7px 13px; border-radius: 9px; border: 1px solid rgba(123,127,178,0.3);
  background: rgba(123,127,178,0.08); color: inherit; font-size: 13px; cursor: pointer; }
button:hover { background: rgba(123,127,178,0.16); }
button.warn { border-color: rgba(220,120,120,0.4); background: rgba(220,120,120,0.08); }
.msg { font-size: 13px; color: #5a8f6a; margin: 6px 0 16px; }
code { font-family: ui-monospace, Menlo, monospace; background: rgba(0,0,0,0.06); padding: 1px 6px; border-radius: 5px; }
.state { background: rgba(0,0,0,0.04); border: 1px solid rgba(0,0,0,0.08); border-radius: 10px;
  padding: 12px 14px; font-size: 12px; line-height: 1.5; overflow: auto; white-space: pre-wrap; }
</style>
