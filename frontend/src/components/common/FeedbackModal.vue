<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="show" class="modal-mask" @click.self="$emit('close')">
        <div class="modal-card">
          <div class="modal-header">
            <span class="modal-title">提交反馈</span>
            <button class="modal-close" @click="$emit('close')">✕</button>
          </div>

          <template v-if="!done">
            <!-- 分类 -->
            <div class="cat-row">
              <button
                v-for="c in categories" :key="c.value"
                class="cat-btn"
                :class="{ active: category === c.value }"
                @click="category = c.value"
              >
                <component :is="c.icon" :size="13" weight="bold" />
                {{ c.label }}
              </button>
            </div>

            <!-- 内容 -->
            <textarea
              v-model="content"
              class="feedback-textarea"
              :placeholder="placeholder"
              maxlength="1000"
              rows="5"
            />
            <div class="char-count">{{ content.length }} / 1000</div>

            <div v-if="error" class="error-msg">{{ error }}</div>

            <button class="submit-btn" :disabled="submitting || !content.trim()" @click="submit">
              {{ submitting ? '提交中…' : '提交反馈' }}
            </button>
          </template>

          <!-- 成功态 -->
          <div v-else class="done-state">
            <div class="done-icon">✓</div>
            <div class="done-text">感谢你的反馈！</div>
            <div class="done-sub">我们会认真看的 🙂</div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { PhWarningOctagon, PhLightbulb, PhChatCircle } from '@phosphor-icons/vue'

const props = defineProps({ show: Boolean })
defineEmits(['close'])

async function apiFeedback(category, content) {
  const token = localStorage.getItem('user_token')
  const res = await fetch('/api/v1/feedback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ category, content }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || '提交失败')
  }
}

const categories = [
  { value: 'bug',        icon: PhWarningOctagon, label: 'Bug' },
  { value: 'suggestion', icon: PhLightbulb,    label: '建议' },
  { value: 'other',      icon: PhChatCircle,   label: '其他' },
]

const category  = ref('suggestion')
const content   = ref('')
const submitting = ref(false)
const error     = ref('')
const done      = ref(false)

const placeholder = computed(() => {
  if (category.value === 'bug')        return '描述一下问题是什么、怎么复现的…'
  if (category.value === 'suggestion') return '说说你的想法或期望的功能…'
  return '随便聊聊…'
})

watch(() => props.show, (v) => {
  if (v) { content.value = ''; error.value = ''; done.value = false }
})

async function submit() {
  if (!content.value.trim()) return
  submitting.value = true; error.value = ''
  try {
    await apiFeedback(category.value, content.value.trim())
    done.value = true
  } catch (e) {
    error.value = e.message || '提交失败，请稍后再试'
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.modal-mask {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.25);
  display: flex; align-items: center; justify-content: center;
}
.modal-card {
  width: 400px;
  background: rgba(255,255,255,0.82);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.76);
  border-radius: 18px; padding: 28px 28px 24px;
  box-shadow: 0 20px 60px rgba(80,90,110,0.16),
              inset 0 1px 0 rgba(255,255,255,0.95);
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 20px;
}
.modal-title { font-size: 15px; font-weight: 700; color: #1e2028; }
.modal-close {
  background: none; border: none; font-size: 14px;
  color: #aaa; cursor: pointer; padding: 2px 6px;
  border-radius: 6px; transition: background 0.15s;
}
.modal-close:hover { background: rgba(0,0,0,0.06); color: #555; }

.cat-row { display: flex; gap: 8px; margin-bottom: 14px; }
.cat-btn {
  flex: 1; padding: 7px 0;
  display: flex; align-items: center; justify-content: center; gap: 5px;
  background: rgba(255,255,255,0.6);
  border: 1px solid rgba(200,204,220,0.6);
  border-radius: 9px; font-size: 12px; font-weight: 600; cursor: pointer;
  color: #6b7280; transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
}
.cat-btn:hover { background: rgba(255,255,255,0.85); }
.cat-btn.active {
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border-color: transparent; color: white;
  box-shadow: 0 3px 10px rgba(123,127,178,0.3);
}

.feedback-textarea {
  width: 100%; padding: 10px 12px; resize: none;
  background: rgba(255,255,255,0.7);
  border: 1px solid rgba(200,204,220,0.6);
  border-radius: 10px; font-size: 13px;
  font-family: var(--font-sans); color: #1e2028;
  outline: none; transition: border-color 0.15s, box-shadow 0.15s;
  box-sizing: border-box;
}
.feedback-textarea:focus {
  border-color: rgba(123,127,178,0.5);
  box-shadow: 0 0 0 3px rgba(123,127,178,0.1);
}
.feedback-textarea::placeholder { color: #b0b4c4; }

.char-count {
  text-align: right; font-size: 11px; color: #b0b4c4;
  margin-top: 4px; margin-bottom: 14px;
}

.error-msg {
  font-size: 12px; color: #c05050; margin-bottom: 10px;
  padding: 7px 11px; border-radius: 8px;
  background: rgba(200,80,80,0.08); border: 1px solid rgba(200,80,80,0.15);
}

.submit-btn {
  width: 100%; padding: 10px;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border: none; border-radius: 10px;
  font-size: 13px; font-weight: 600; color: white;
  cursor: pointer; transition: opacity 0.15s, transform 0.15s;
  box-shadow: 0 4px 14px rgba(123,127,178,0.3);
}
.submit-btn:hover:not(:disabled) { opacity: 0.88; transform: translateY(-1px); }
.submit-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.done-state {
  text-align: center; padding: 20px 0 8px;
}
.done-icon {
  width: 48px; height: 48px; border-radius: 50%; margin: 0 auto 14px;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; color: white;
  box-shadow: 0 6px 18px rgba(123,127,178,0.35);
}
.done-text { font-size: 15px; font-weight: 700; color: #1e2028; margin-bottom: 6px; }
.done-sub  { font-size: 13px; color: #8a8fa8; }

.modal-fade-enter-active, .modal-fade-leave-active { transition: opacity 0.18s; }
.modal-fade-enter-from, .modal-fade-leave-to { opacity: 0; }
</style>
