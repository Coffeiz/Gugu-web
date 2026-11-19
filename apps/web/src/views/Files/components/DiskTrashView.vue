<template>
  <div v-if="error" class="disk-trash-status" role="alert">
    {{ error }}
    <ActionButton fit variant="secondary" @click="emit('load')">{{ t('common.actions.retry') }}</ActionButton>
  </div>
  <FileBrowserEmptyState v-else-if="loading && !entries.length" loading variant="list" :text="t('common.status.loading')" />
  <div v-else-if="entries.length" class="file-list disk-trash-list">
    <div class="list-head">
      <span>{{ t('filesViewUi.name') }}</span>
      <span>{{ t('filesViewUi.type') }}</span>
      <span>{{ t('filesViewUi.deletedAt') }}</span>
      <span />
    </div>
    <div v-for="{ entry, ext, color, icon, deletedAtLabel } in rows" :key="entry.id" class="list-row"
      :class="{ 'folder-row': entry.kind === 'directory', selected: selected.has(entry.id) }"
      @click.stop="selectionMode && emit('select', entry.id)">
      <span class="lr-name-cell">
        <Icon v-if="entry.kind === 'directory'" name="file.folder" class="lr-folder-icon" :size="16" />
        <component v-else :is="icon" class="lr-file-icon" :size="16" :style="{ color }" />
        <span class="lr-filename" :title="entry.relativePath">{{ entry.name }}</span>
      </span>
      <span class="lr-type-cell">
        <span v-if="ext" class="lr-ext" :style="{ color, background: color + '18' }">{{ ext }}</span>
        <span v-else class="lr-type-text">{{ entry.kind === 'directory' ? t('filesViewUi.folder') : '—' }}</span>
      </span>
      <time class="lr-text" :datetime="entry.deletedAt" :title="deletedAtLabel">{{ deletedAtLabel }}</time>
      <span class="lr-actions">
        <button v-if="selectionMode" type="button" role="checkbox" class="trash-select"
          :aria-checked="selected.has(entry.id)" :aria-label="entry.name" @click.stop="emit('select', entry.id)">
          <span class="sel-checkbox" :class="{ checked: selected.has(entry.id) }" aria-hidden="true" />
        </button>
        <template v-else>
          <button type="button" class="file-list-btn trash-restore" :disabled="busy" @click.stop="emit('restore', entry)">
            {{ t('filesViewUi.restore') }}
          </button>
          <button type="button" class="file-list-btn del" :disabled="busy" :title="t('filesViewUi.permanentDelete')"
            :aria-label="t('filesViewUi.permanentDelete')" @click.stop="emit('purge', entry)">
            <Icon name="action.delete" :size="12" />
          </button>
        </template>
      </span>
    </div>
  </div>
  <FileBrowserEmptyState v-else variant="trash" :text="t('filesViewUi.emptyTrash')" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
import Icon from '@/components/common/icons/Icon.vue'
import type { DiskTrashEntry } from '@/services/api'
import { splitName } from '@/utils/fileParse'
import { fileIconColor, fileListIcon } from '@/utils/fileTypes'

const props = defineProps<{
  entries: DiskTrashEntry[]
  loading: boolean
  error: string
  busy: boolean
  selectionMode: boolean
  selected: ReadonlySet<string>
}>()
const emit = defineEmits<{ load: []; select: [id: string]; restore: [entry: DiskTrashEntry]; purge: [entry: DiskTrashEntry] }>()
const { t, locale } = useI18n()
const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'short', timeStyle: 'short' }))
const rows = computed(() => props.entries.map(entry => {
  const ext = entry.kind === 'file' ? splitName(entry.name).ext : ''
  return { entry, ext, color: fileIconColor(ext), icon: fileListIcon(ext), deletedAtLabel: dateFormat.value.format(new Date(entry.deletedAt)) }
}))
</script>

<style scoped>
.disk-trash-status { padding: var(--space-md); color: var(--content-secondary); }
.disk-trash-list :is(.list-head, .list-row) {
  grid-template-columns: minmax(0, 1fr) clamp(42px, 8vw, 90px) clamp(86px, 15vw, 160px) 88px;
}
.lr-ext, .lr-type-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lr-type-cell .lr-ext { flex-shrink: 1; }
.trash-restore { width: auto; padding-inline: 6px; font-size: 11px; white-space: nowrap; }
.trash-select { position: relative; width: 24px; height: 24px; border: 0; background: none; color: inherit; cursor: pointer; }
.trash-select .sel-checkbox { right: 4px; }
.list-row:focus-within .file-list-btn { opacity: 1; }
.file-list-btn:disabled { cursor: default; }
@media (hover: none) {
  .disk-trash-list .file-list-btn { opacity: 1; }
}
</style>
