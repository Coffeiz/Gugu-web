<template>
  <BaseModal :show="show" width="400px" background="var(--modal-card-bg)" @close="$emit('close')">
    <div class="feedback-modal">
          <div class="modal-header">
            <span class="modal-title">{{ t('feedback.title') }}</span>
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
              {{ submitting ? t('feedback.submitting') : t('feedback.submit') }}
            </button>
          </template>

          <!-- 成功态 -->
          <div v-else class="done-state">
            <div class="done-icon">✓</div>
            <div class="done-text">{{ t('feedback.success') }}</div>
            <div class="done-sub">{{ t('feedback.successHint') }}</div>
          </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({ show: Boolean })
defineEmits(['close'])
const { t } = useI18n()

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
    throw new Error(data.detail || t('feedback.submitFailed'))
  }
}

const categories = computed(() => [
  { value: 'bug',        icon: 'status.warning-octagon', label: 'Bug' },
  { value: 'suggestion', icon: 'status.info',            label: t('feedback.suggestion') },
  { value: 'other',      icon: 'communication.chat',     label: t('feedback.other') },
])

const category  = ref('suggestion')
const content   = ref('')
const submitting = ref(false)
const error     = ref('')
const done      = ref(false)

const placeholder = computed(() => {
  if (category.value === 'bug')        return t('feedback.bugPlaceholder')
  if (category.value === 'suggestion') return t('feedback.suggestionPlaceholder')
  return t('feedback.otherPlaceholder')
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
    error.value = (e instanceof Error ? e.message : '') || t('feedback.submitFailed')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.feedback-modal { padding: 28px 28px 24px; }
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
  /* 分类胶囊不是主操作按钮：使用纯主题色，避免渐变和卡片内描边制造白色高光。 */
  background: var(--action-primary);
  border-color: transparent; color: var(--content-on-accent);
  box-shadow: none;
}
.cat-btn.active:hover { background: var(--action-primary-hover); }

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

</style>
