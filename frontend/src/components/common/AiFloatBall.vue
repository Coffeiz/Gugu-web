<template>
  <!-- 悬浮球 -->
  <button class="ai-fab" ref="fabRef" @click="open = !open" title="PM Agent">
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="white"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 3C7 3 4 6 4 10c0 2.5 1.2 4.7 3 6v3l3-1.5c.3.1.7.1 1 .1 4 0 7-3 7-7s-3-7-7-7z"/>
      <circle cx="8" cy="10" r="1" fill="white" stroke="none"/>
      <circle cx="11" cy="10" r="1" fill="white" stroke="none"/>
      <circle cx="14" cy="10" r="1" fill="white" stroke="none"/>
    </svg>
  </button>

  <!-- 对话浮层 -->
  <Transition name="chat-popup">
    <div v-if="open" class="ai-popup" ref="popupRef">
      <!-- 头部 -->
      <div class="popup-header">
        <div class="popup-avatar">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="white"
            stroke-width="1.6" stroke-linecap="round">
            <path d="M7 1l1.5 3h3l-2.5 2 1 3L7 7.5 4 9l1-3L2.5 4h3z"/>
          </svg>
        </div>
        <span class="popup-title">PM Agent</span>
        <span class="popup-status">
          <em class="status-dot" />在线
        </span>
        <button class="popup-close" @click="open = false">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
            stroke-width="1.8" stroke-linecap="round">
            <path d="M2 2l10 10M12 2L2 12"/>
          </svg>
        </button>
      </div>

      <!-- 消息列表 -->
      <div class="popup-messages" ref="messagesEl">
        <div v-for="(msg, i) in messages" :key="i" :class="['msg', msg.role]">
          <div class="msg-bubble" v-html="msg.text" />
          <div class="msg-time">{{ msg.time }}</div>
        </div>
        <div v-if="thinking" class="msg ai">
          <div class="msg-bubble thinking">
            <span /><span /><span />
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="popup-input-row">
        <input
          v-model="inputText"
          placeholder="问问项目进度、截止日期…"
          @keydown.enter="send"
        />
        <button class="send-btn" @click="send">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="white"
            stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 6.5h11M7 1.5l5 5-5 5"/>
          </svg>
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, nextTick, onMounted, onUnmounted } from 'vue'

const open = ref(false)
const fabRef = ref(null)
const popupRef = ref(null)

function handleClickOutside(e) {
  if (!open.value) return
  if (fabRef.value?.contains(e.target)) return
  if (popupRef.value?.contains(e.target)) return
  open.value = false
}

onMounted(() => document.addEventListener('click', handleClickOutside, true))
onUnmounted(() => document.removeEventListener('click', handleClickOutside, true))
const inputText = ref('')
const thinking = ref(false)
const messagesEl = ref(null)

const now = () => {
  const d = new Date()
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

const messages = ref([
  { role: 'ai', text: '你好！今天有 <strong>1 个紧急截止</strong>：《角色设定集 Vol.3》6月18日，目前进度 20% ⚠', time: now() },
])

const REPLIES = {
  '截稿': '本月截止共 3 个：<br>① 角色设定集 6/18 ⚠<br>② 月光少女 6/20<br>③ UI图标 6/30',
  '进度': '月光少女 65%、拜年祭 40%、角色设定 20%、UI图标 90%。',
  '提醒': '好的，截稿前 48 小时提醒你。',
  '文件': '最近 6 个文件已自动按项目归档。',
  '排期': '当前最近排期：6/18 角色设定集草稿、6/20 月光少女上色、6/28 拜年祭线稿审查。',
}

async function send() {
  const text = inputText.value.trim()
  if (!text) return
  messages.value.push({ role: 'user', text, time: now() })
  inputText.value = ''
  await scrollBottom()

  thinking.value = true
  await new Promise(r => setTimeout(r, 600))
  thinking.value = false

  const key = Object.keys(REPLIES).find(k => text.includes(k))
  messages.value.push({ role: 'ai', text: key ? REPLIES[key] : '收到，我来帮你查一下…', time: now() })
  await scrollBottom()
}

async function scrollBottom() {
  await nextTick()
  if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
}
</script>

<style scoped>
.ai-fab {
  position: fixed;
  bottom: 28px; right: 28px;
  width: 50px; height: 50px;
  border-radius: 50%;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border: none;
  cursor: pointer;
  z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 18px rgba(123,127,178,0.32), inset 0 1px 0 rgba(255,255,255,0.45);
  transition: transform 0.2s, box-shadow 0.2s;
}
.ai-fab:hover {
  transform: scale(1.08);
  box-shadow: 0 7px 24px rgba(123,127,178,0.42), inset 0 1px 0 rgba(255,255,255,0.5);
}

.ai-popup {
  position: fixed;
  bottom: 88px; right: 28px;
  width: 316px;
  background: rgba(242, 242, 248, 0.9);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 20px;
  box-shadow: var(--glass-shadow-lg);
  display: flex; flex-direction: column;
  z-index: 999;
  overflow: hidden;
}

.popup-header {
  display: flex; align-items: center; gap: 9px;
  padding: 13px 14px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.5);
}
.popup-avatar {
  width: 27px; height: 27px; border-radius: 50%;
  background: linear-gradient(135deg, #7b7fb2, #7ab8c8);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.popup-title { font-size: 13px; font-weight: 700; flex: 1; }
.popup-status {
  font-size: 11px; color: var(--color-success);
  display: flex; align-items: center; gap: 4px;
}
.status-dot {
  display: inline-block; width: 6px; height: 6px;
  border-radius: 50%; background: var(--color-success);
}
.popup-close {
  background: none; border: none; cursor: pointer;
  color: var(--text-secondary); padding: 3px;
  border-radius: 6px; display: flex;
  transition: background 0.15s;
}
.popup-close:hover { background: rgba(0,0,0,0.06); }

.popup-messages {
  flex: 1; overflow-y: auto;
  padding: 12px 13px;
  display: flex; flex-direction: column; gap: 8px;
  max-height: 270px;
}

.msg { display: flex; flex-direction: column; }
.msg.user { align-items: flex-end; }
.msg.ai { align-items: flex-start; }

.msg-bubble {
  padding: 9px 13px;
  border-radius: 13px;
  font-size: 13px;
  line-height: 1.5;
  max-width: 88%;
}
.msg.ai .msg-bubble {
  background: rgba(255,255,255,0.5);
  border: 1px solid rgba(255,255,255,0.65);
  border-bottom-left-radius: 4px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.8);
}
.msg.user .msg-bubble {
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white;
  border-bottom-right-radius: 4px;
}
.msg-time { font-size: 10px; color: var(--text-secondary); margin-top: 3px; padding: 0 3px; }

/* 思考动画 */
.thinking {
  display: flex; gap: 4px; align-items: center;
  padding: 12px 16px;
}
.thinking span {
  display: inline-block;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: bounce 1.2s infinite;
  opacity: 0.6;
}
.thinking span:nth-child(2) { animation-delay: 0.2s; }
.thinking span:nth-child(3) { animation-delay: 0.4s; }
@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-5px); }
}

.popup-input-row {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 13px;
  border-top: 1px solid rgba(255,255,255,0.5);
  background: rgba(255,255,255,0.28);
}
.popup-input-row input {
  flex: 1; border: none; background: none;
  font-size: 13px; color: var(--text-primary);
  outline: none; font-family: var(--font-sans);
}
.popup-input-row input::placeholder { color: var(--text-secondary); }
.send-btn {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: transform 0.15s; flex-shrink: 0;
}
.send-btn:hover { transform: scale(1.1); }

/* 弹出动画 */
.chat-popup-enter-active { transition: opacity 0.2s, transform 0.22s cubic-bezier(.34,1.56,.64,1); }
.chat-popup-leave-active { transition: opacity 0.15s, transform 0.15s; }
.chat-popup-enter-from, .chat-popup-leave-to { opacity: 0; transform: scale(0.92) translateY(10px); }
</style>
