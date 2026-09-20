<template>
  <span class="rename-sizer" :class="{ 'rename-sizer--segmented': props.extension !== undefined }"
    @pointerdown.stop @mousedown.stop @click.stop @focusin="onFocusIn" @focusout="onFocusOut">
    <template v-if="props.extension !== undefined">
      <span class="rename-segment-field rename-file-name-field">
        <input
          ref="nameInputRef"
          class="rename-input-inline rename-file-name-input"
          :value="props.modelValue"
          :aria-label="t('filesUi.fileNameWithoutExtension')"
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
          v-enter="commit"
          @keydown.esc="cancel"
          @focus="selectPart"
        />
      </span>
      <span class="rename-segment-dot" aria-hidden="true">.</span>
      <span class="rename-segment-field rename-file-extension-field">
        <input
          class="rename-input-inline rename-file-extension-input"
          :value="props.extension"
          :aria-label="t('filesUi.fileExtension')"
          :required="props.extensionRequired"
          maxlength="10"
          pattern="[A-Za-z0-9_-]{1,10}"
          :title="t('filesUi.extensionInvalid')"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          @input="emit('update:extension', ($event.target as HTMLInputElement).value)"
          v-enter="commit"
          @keydown.esc="cancel"
          @focus="selectPart"
        />
      </span>
    </template>
    <template v-else>
      <span class="rename-ghost">{{ props.modelValue || ' ' }}</span>
      <input
        ref="nameInputRef"
        class="rename-input-inline"
        :value="props.modelValue"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        v-enter="commit"
        @keydown.esc="cancel"
        @focus="selectPart"
      />
    </template>
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * 全站共用的内联重命名输入框。
 * 样式（.rename-sizer / .rename-ghost / .rename-input-inline）在 global.css 统一维护。
 * 文件名可额外传 extension，显示为名称与后缀两个输入段；文件夹继续使用单输入框。
 */
const props = withDefaults(defineProps<{
  modelValue: string
  extension?: string
  extensionRequired?: boolean
}>(), { extensionRequired: false })
const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:extension': [value: string]
  commit: []
  cancel: []
}>()
const { t } = useI18n()
const nameInputRef = ref<HTMLInputElement | null>(null)
let autofocusFrame = 0
let focusOutTimer: number | undefined

onMounted(() => {
  autofocusFrame = window.requestAnimationFrame(() => nameInputRef.value?.focus())
})
onBeforeUnmount(() => {
  window.cancelAnimationFrame(autofocusFrame)
  if (focusOutTimer !== undefined) window.clearTimeout(focusOutTimer)
})

function commit() {
  emit('commit')
}
function cancel() {
  emit('cancel')
}
function onFocusIn() {
  if (focusOutTimer !== undefined) {
    window.clearTimeout(focusOutTimer)
    focusOutTimer = undefined
  }
}
function selectPart(event: FocusEvent) {
  const input = event.target as HTMLInputElement
  input.select()
}
function onFocusOut(event: FocusEvent) {
  const current = event.currentTarget as HTMLElement
  const next = event.relatedTarget
  if (props.extension !== undefined && next && current.contains(next as Node)) return

  const motionToken = window.getComputedStyle(current).getPropertyValue('--motion-hover-control').trim()
  const parsedDuration = /^([\d.]+)(ms|s)$/.exec(motionToken)
  const durationMs = parsedDuration
    ? Number(parsedDuration[1]) * (parsedDuration[2] === 's' ? 1000 : 1)
    : 150
  if (durationMs === 0) {
    commit()
    return
  }
  focusOutTimer = window.setTimeout(() => {
    focusOutTimer = undefined
    commit()
  }, durationMs)
}
</script>
