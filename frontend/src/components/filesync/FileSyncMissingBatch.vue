<template>
  <div v-if="groups.length || busy || result" class="missing-batch">
    <div class="missing-actions">
      <ActionButton v-for="group in groups" :key="group.id" variant="secondary" fit
                    :disabled="disabled || busy" @click="start(group.id)">
        {{ t('filesyncAdmin.missingBatchPreview', { binding: group.id, count: group.count }) }}
      </ActionButton>
      <ActionButton v-if="busy" variant="secondary" fit @click="cancelled = true">
        {{ t('common.actions.cancel') }}
      </ActionButton>
    </div>
    <p v-if="busy" role="status">{{ t('filesyncAdmin.bulkProgress', { done, total }) }}</p>
    <p v-if="result" role="status">{{ result }}</p>
    <ul v-if="failures.length"><li v-for="failure in failures" :key="failure.id">#{{ failure.id }} · {{ failure.reason }}</li></ul>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { filesyncAdminApi, type FileSyncConflictStatus } from '@/api/filesync'
import ActionButton from '@/components/common/controls/ActionButton.vue'

const props = defineProps<{ conflicts: FileSyncConflictStatus[]; disabled?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; changed: [] }>()
const { t } = useI18n()
const admin = useAdminStore()
const busy = ref(false)
const cancelled = ref(false)
const done = ref(0)
const total = ref(0)
const result = ref('')
const failures = ref<Array<{ id: number; reason?: string }>>([])
let mounted = true
onBeforeUnmount(() => { mounted = false; cancelled.value = true })
const groups = computed(() => {
  const counts = new Map<number, number>()
  for (const conflict of props.conflicts) {
    if (!conflict.hasLocal) counts.set(conflict.bindingId, (counts.get(conflict.bindingId) || 0) + 1)
  }
  return [...counts].map(([id, count]) => ({ id, count }))
})

async function start(bindingId: number) {
  if (busy.value || props.disabled) return
  busy.value = true
  cancelled.value = false
  done.value = 0
  total.value = 0
  result.value = ''
  failures.value = []
  emit('busy', true)
  try {
    const preview = await filesyncAdminApi.previewMissing(admin.authFetch, bindingId)
    total.value = preview.items.length
    if (!mounted || cancelled.value) return
    if (!total.value) { result.value = t('filesyncAdmin.missingBatchEmpty'); return }
    const accepted = await confirmDialog({
      title: t('filesyncAdmin.missingBatchTitle'), tone: 'danger',
      message: t('filesyncAdmin.missingBatchConfirm', {
        binding: bindingId, count: total.value,
        paths: preview.items.slice(0, 5).map(item => item.relativePath).join('\n'),
      }),
      confirmText: t('filesyncAdmin.confirmMissingDelete'),
    })
    if (!accepted || cancelled.value || !mounted) return
    for (let offset = 0; offset < total.value && !cancelled.value; offset += 25) {
      const batch = await filesyncAdminApi.applyMissing(admin.authFetch, preview, preview.items.slice(offset, offset + 25))
      done.value += batch.results.length
      failures.value.push(...batch.results.filter(item => item.status !== 'completed'))
    }
    result.value = t('filesyncAdmin.missingBatchResult', {
      completed: done.value - failures.value.length, skipped: failures.value.length,
      remaining: total.value - done.value,
    })
  } catch (error) {
    result.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
    if (mounted) { emit('busy', false); emit('changed') }
  }
}
</script>

<style scoped>
.missing-batch { display: contents; }
.missing-batch p, .missing-batch li { color: var(--content-secondary); font-size: var(--font-size-sm); overflow-wrap: anywhere; }
.missing-actions { display: contents; }
.missing-batch ul { max-height: 180px; overflow: auto; }
</style>
