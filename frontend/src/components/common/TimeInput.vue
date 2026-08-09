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
.time-input.boxed { width: 100%; padding: 8px 11px; border: 1px solid rgba(0,0,0,0.1); border-radius: var(--radius-sm); background: rgba(255,255,255,0.72); transition: border-color 0.15s, box-shadow 0.15s; }
.time-input.boxed:focus-within { border-color: rgba(123,127,178,0.55); box-shadow: 0 0 0 3px rgba(123,127,178,0.12); background: rgba(255,255,255,0.85); }
.time-part { width: 22px; border: none; background: transparent; outline: none; padding: 0; text-align: center; font: 13px var(--font-sans); font-variant-numeric: tabular-nums; color: var(--text-primary); }
.time-part::placeholder { color: var(--text-secondary); opacity: .65; }
.time-colon { color: var(--text-secondary); font-size: 13px; font-weight: 600; line-height: 1; }
</style>
