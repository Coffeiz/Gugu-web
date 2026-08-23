<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="show" class="modal-mask" :style="{ zIndex: myZ }" @click.self="$emit('close')">
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
                <Icon :name="c.icon" size="sm" tone="inherit" />
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

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { nextZ } from '@/composables/windowz'

const props = defineProps({ show: Boolean })
defineEmits(['close'])

// 打断式弹窗:打开时领新 z,盖当前最顶窗口
const myZ = ref(0)
watch(() => props.show, v => { if (v) myZ.value = nextZ() })

async function apiFeedback(category: string, content: string) {
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
  { value: 'bug',        icon: 'status.warning-octagon', label: 'Bug' },
  { value: 'suggestion', icon: 'status.info',            label: '建议' },
  { value: 'other',      icon: 'communication.chat',     label: '其他' },
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
    error.value = (e instanceof Error ? e.message : '') || '提交失败，请稍后再试'
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
/* 全套表面消费语义 token（modal-card / option / input / action），与其他弹窗
   （ScheduleFormModal、活动弹窗）同一契约，亮暗主题自动适配。 */
.modal-mask {
  position: fixed; inset: 0;   /* z-index 由 :style 动态(打开时盖当前最顶窗口) */
  background: var(--scrim);
  display: flex; align-items: center; justify-content: center;
}
.modal-card {
  width: 400px;
  background: var(--modal-card-bg);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid var(--modal-card-border);
  border-radius: 18px; padding: 28px 28px 24px;
  box-shadow: var(--modal-card-shadow),
              inset 0 1px 0 var(--modal-card-highlight);
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 20px;
}
.modal-title { font-size: 15px; font-weight: 700; color: var(--content-primary); }
.modal-close {
  background: none; border: none; font-size: 14px;
  color: var(--content-secondary); cursor: pointer; padding: 2px 6px;
  border-radius: 6px; transition: background 0.15s;
}
.modal-close:hover { background: var(--action-soft); color: var(--content-primary); }

.cat-row { display: flex; gap: 8px; margin-bottom: 14px; }
.cat-btn {
  flex: 1; padding: 7px 0;
  display: flex; align-items: center; justify-content: center; gap: 5px;
  background: var(--option-bg);
  border: 1px solid var(--option-border);
  border-radius: 9px; font-size: 12px; font-weight: 600; cursor: pointer;
  color: var(--option-fg); transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
}
.cat-btn:hover { background: var(--option-bg-hover); border-color: var(--option-border-hover); }
.cat-btn.active {
  background: var(--action-primary-bg);
  border-color: transparent; color: var(--content-on-accent);
  box-shadow: var(--elevation-card);
}

.feedback-textarea {
  width: 100%; padding: 10px 12px; resize: none;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 10px; font-size: 13px;
  font-family: var(--font-sans); color: var(--input-fg);
  outline: none; transition: border-color 0.15s, box-shadow 0.15s;
  box-sizing: border-box;
}
/* 与 hover 同特异度、源顺序在后：聚焦后悬停不丢 focus 描边。 */
.feedback-textarea:hover:not(:disabled) { background: var(--input-bg-hover); border-color: var(--input-border-hover); }
.feedback-textarea:focus:not(:disabled) {
  border-color: var(--input-border-focus);
  box-shadow: var(--input-focus-shadow);
}
.feedback-textarea::placeholder { color: var(--input-placeholder); }

.char-count {
  text-align: right; font-size: 11px; color: var(--content-tertiary);
  margin-top: 4px; margin-bottom: 14px;
}

.error-msg {
  font-size: 12px; color: var(--status-danger); margin-bottom: 10px;
  padding: 7px 11px; border-radius: 8px;
  background: var(--status-danger-bg); border: 1px solid color-mix(in srgb,var(--status-danger) 22%,transparent);
}

.submit-btn {
  width: 100%; padding: 10px;
  background: var(--action-primary-bg);
  border: none; border-radius: 10px;
  font-size: 13px; font-weight: 600; color: var(--content-on-accent);
  cursor: pointer; transition: opacity 0.15s, transform 0.15s;
  box-shadow: var(--elevation-card);
}
.submit-btn:hover:not(:disabled) { opacity: 0.88; transform: translateY(-1px); }
.submit-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.done-state {
  text-align: center; padding: 20px 0 8px;
}
.done-icon {
  width: 48px; height: 48px; border-radius: 50%; margin: 0 auto 14px;
  background: var(--action-primary-bg);
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; color: var(--content-on-accent);
  box-shadow: var(--elevation-card);
}
.done-text { font-size: 15px; font-weight: 700; color: var(--content-primary); margin-bottom: 6px; }
.done-sub  { font-size: 13px; color: var(--content-secondary); }

.modal-fade-enter-active, .modal-fade-leave-active { transition: opacity 0.18s; }
.modal-fade-enter-from, .modal-fade-leave-to { opacity: 0; }
</style>
