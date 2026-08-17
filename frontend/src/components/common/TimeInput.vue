<template>
  <div class="time-input" :class="{ boxed }">
    <input
      ref="hourRef"
      class="time-part"
      :value="hour"
      inputmode="numeric"
      maxlength="2"
      placeholder="HH"
      aria-label="小时"
      @focus="selectPart"
      @input="onPartInput('hour', $event)"
      @paste="onPaste"
      @blur="onBlur"
    />
    <span class="time-colon" aria-hidden="true">:</span>
    <input
      ref="minuteRef"
      class="time-part"
      :value="minute"
      inputmode="numeric"
      maxlength="2"
      placeholder="MM"
      aria-label="分钟"
      @focus="selectPart"
      @input="onPartInput('minute', $event)"
      @paste="onPaste"
      @blur="onBlur"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: string
  boxed?: boolean
}>(), { boxed: true })
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const hourRef = ref<HTMLInputElement | null>(null)
const minuteRef = ref<HTMLInputElement | null>(null)
const hour = computed(() => (props.modelValue || '').split(':')[0]?.replace(/\D/g, '').slice(0, 2) || '')
const minute = computed(() => (props.modelValue || '').split(':')[1]?.replace(/\D/g, '').slice(0, 2) || '')

function selectPart(e: Event) {
  const input = e.target as HTMLInputElement
  nextTick(() => input.select())
}

function publish(h: string, m: string) {
  emit('update:modelValue', h ? `${h}:${m}` : '')
}

function onPartInput(part: 'hour' | 'minute', e: Event) {
  const input = e.target as HTMLInputElement
  const digits = input.value.replace(/\D/g, '').slice(0, 2)
  const h = part === 'hour' ? digits : hour.value
  const m = part === 'minute' ? digits : minute.value
  publish(h, m)
  if (part === 'hour' && digits.length === 2) nextTick(() => minuteRef.value?.focus())
}

function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text') || ''
  const digits = text.replace(/\D/g, '').slice(0, 4)
  if (digits.length < 3) return
  e.preventDefault()
  publish(digits.slice(0, 2), digits.slice(2))
  nextTick(() => minuteRef.value?.focus())
}

function onBlur() {
  const h = Number(hour.value)
  const m = Number(minute.value)
  if (!hour.value && !minute.value) return emit('update:modelValue', '')
  emit('update:modelValue', `${String(Math.min(23, Number.isFinite(h) ? h : 0)).padStart(2, '0')}:${String(Math.min(59, Number.isFinite(m) ? m : 0)).padStart(2, '0')}`)
}
</script>

<style scoped>
.time-input { display: inline-flex; align-items: center; justify-content: center; gap: 0; min-width: 82px; height: 34px; box-sizing: border-box; }
.time-input:not(.boxed) { min-width: 52px; height: 18px; }
/* 全仓唯一的时间选择框实现：统一消费 --input-* 语义 token（与添加活动弹窗的
   .time-box / popup-input 同一套描边输入框契约），亮暗主题自动适配。 */
.time-input.boxed { width: 100%; padding: 8px 11px; border: 1px solid var(--input-border); border-radius: var(--radius-sm); background: var(--input-bg); color: var(--input-fg); transition: border-color 0.15s, box-shadow 0.15s, background 0.15s; }
.time-input.boxed:hover { border-color: var(--input-border-hover); background: var(--input-bg-hover); }
.time-input.boxed:focus-within { border-color: var(--input-border-focus); box-shadow: var(--input-focus-shadow); background: var(--input-bg-focus); }
.time-part { width: 22px; border: none; background: transparent; outline: none; padding: 0; text-align: center; font: 13px var(--font-sans); font-variant-numeric: tabular-nums; color: var(--text-primary); }
.time-part::placeholder { color: var(--text-secondary); opacity: .65; }
.time-colon { color: var(--text-secondary); font-size: 13px; font-weight: 600; line-height: 1; }
</style>
