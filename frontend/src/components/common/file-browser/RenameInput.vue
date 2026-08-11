<template>
  <span class="rename-sizer" @click.stop>
    <span class="rename-ghost">{{ modelValue || ' ' }}</span>
    <input
      class="rename-input-inline"
      :value="modelValue"
      v-enter="commit"
      @keydown.esc="cancel"
      @blur="commit"
      @focus="($event.target as HTMLInputElement).select()"
    />
  </span>
</template>

<script setup lang="ts">
/**
 * 全站共用的内联重命名输入框。
 * 样式（.rename-sizer / .rename-ghost / .rename-input-inline）在 global.css 统一维护。
 * 用法：v-model 绑定当前编辑文本，@commit 在确认（Enter / 失焦）时触发，@cancel 在 Esc 时触发。
 */
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ commit: []; cancel: [] }>()

function commit() {
  emit('commit')
}
function cancel() {
  emit('cancel')
}
</script>
