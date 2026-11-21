<template>
  <button
    v-if="supported"
    class="btn-test"
    :class="{ loading }"
    :disabled="loading"
    :title="title"
    @click="$emit('initialize')"
  >
    <svg v-if="loading" class="spin-icon" width="12" height="12" viewBox="0 0 12 12"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M6 1v2M6 9v2M1 6h2M9 6h2" />
    </svg>
    {{ loading ? loadingLabel : label }}
  </button>
  <span v-else class="schema-note">{{ managedExternallyNote }}</span>
</template>

<script setup lang="ts">
defineProps<{
  supported: boolean
  loading: boolean
  label: string
  loadingLabel: string
  title: string
  managedExternallyNote: string
}>()

defineEmits<{ initialize: [] }>()
</script>

<style scoped>
.btn-test {
  display: flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 500; padding: 6px 14px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.07);
  color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.btn-test:hover:not(.loading) { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.2); color: rgba(255,255,255,0.75); }
.btn-test.loading { opacity: 0.5; cursor: default; }
.schema-note { max-width: 240px; color: rgba(255,255,255,0.45); font-size: 12px; line-height: 1.5; text-align: right; }
</style>
