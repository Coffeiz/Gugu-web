<template>
  <section class="workspace-files" :aria-busy="pending">
    <div v-if="error" role="alert">
      <p>{{ error }}</p>
      <ActionButton variant="secondary" @click="load">{{ t('common.actions.retry') }}</ActionButton>
    </div>
    <SkeletonGate v-else-if="loading">
      <PageSkeleton :variant="viewMode" :collection="viewMode === 'grid' ? 'files' : undefined" />
    </SkeletonGate>
    <FileBrowserList v-else-if="(!pending || entries.length) && viewMode === 'list'" :layout-collection="runtimeSurfaceId" class="workspace-file-list">
      <div class="list-head">
        <button v-for="key in sortColumns" :key="key" class="lh-sortable workspace-file-open"
          :class="{ active: sortKey === key }" type="button" @click="emit('sortSelect', key)">
          {{ t(`filesViewUi.${key}`) }}
          <span v-if="sortKey === key" aria-hidden="true">{{ sortDir === 'asc' ? '↑' : '↓' }}</span>
        </button>
        <span />
      </div>
      <RuntimeListRow v-for="entry in sortedEntries" :key="entryObjectId(entry)" class="list-row"
        :class="{ 'folder-row': entry.kind === 'directory', cut: cutPaths?.has(entry.relativePath), selected: selected(entry), 'pre-selected': preSelected(entry) }"
        :data-path-file="entry.kind === 'file' ? entry.relativePath : undefined"
        :data-path-folder="entry.kind === 'directory' && !isDownloads(entry) ? entry.relativePath : undefined"
        :runtime-selected="selected(entry)"
        data-layout-role="card" :data-layout-key="entryObjectId(entry)" :runtime-id="entryObjectId(entry)"
        :runtime-type="entry.kind === 'directory' ? 'folder-item' : 'file-item'"
        :runtime-surface-id="runtimeSurfaceId"
        :runtime-abilities="isDownloads(entry) ? [] : ['move']"
        :runtime-target="entryDropTarget(entry)"
        @click.stop="openEntry(entry, $event)" @contextmenu.prevent.stop="openContext(entry, $event)">
        <span class="lr-name-cell">
          <Icon v-if="isDownloads(entry)" name="action.download" class="lr-folder-icon" :size="16" :style="{ color: directoryAccent }" />
          <component v-else-if="entry.kind === 'directory'" :is="directoryIcon" class="lr-folder-icon" :size="16"
            :style="{ color: directoryAccent }" />
          <component v-else :is="fileListIcon(fileName(entry).ext)" class="lr-file-icon" :size="16"
            :style="{ color: fileIconColor(fileName(entry).ext) }" />
          <RenameInput v-if="renamingPath === entry.relativePath" v-model="renameName" @commit="commitRename(entry)" @cancel="cancelRename" />
          <button v-else type="button" class="lr-filename workspace-file-open" :title="entry.name"
            @click.stop="openEntry(entry, $event)">{{ entry.name }}</button>
        </span>
        <span class="lr-type-cell"><span v-if="entry.kind === 'file'" class="lr-ext">{{ fileName(entry).ext }}</span></span>
        <span class="lr-text">{{ entry.kind === 'file' ? fmtBytes(entry.size) : folderCountLabel(entry) }}</span>
        <span class="lr-actions">
          <span v-if="selectionMode && !isDownloads(entry)" class="sel-checkbox" :class="{ checked: selected(entry) }">
            <Icon v-if="selected(entry)" name="status.success" :size="12" />
          </span>
          <template v-else>
            <button v-if="!isDownloads(entry)" type="button" class="file-list-btn" :title="t('sharedUi.rename')"
              :aria-label="t('sharedUi.rename')" @pointerdown.stop @click.stop="startRename(entry)"><Icon name="action.edit" :size="11" /></button>
            <button v-if="!fileOpenAccess && entry.kind === 'file'" type="button" class="file-list-btn"
              :title="t('common.actions.download')" :aria-label="t('common.actions.download')" @pointerdown.stop @click.stop="download(entry)">
              <Icon name="action.download" :size="11" />
            </button>
            <button v-if="!isDownloads(entry)" type="button" class="file-list-btn del" :title="t('sharedUi.moveToTrash')"
              :aria-label="t('sharedUi.moveToTrash')" @pointerdown.stop @click.stop="emit('trash', entry)">
              <Icon name="action.delete" :size="11" />
            </button>
          </template>
        </span>
      </RuntimeListRow>
      <FileUploadGhostCard v-for="ghost in uploadingItems" :key="ghost.uid" mode="list" data-flip-target
        :name="ghost.name" :ext="ghost.ext" :progress="ghost.progress" :error="ghost.error" />
      <FileUploadButton :label="fileOpenAccess ? t('filesUi.addDesktopFile') : undefined" mode="list" data-flip-target @select="selectFiles" />
    </FileBrowserList>
    <FileBrowserGrid v-else-if="!pending || entries.length" :layout-collection="runtimeSurfaceId">
      <template v-for="entry in sortedEntries" :key="entryObjectId(entry)">
        <RuntimeFolderCard v-if="entry.kind === 'directory'"
          :card-props="{ displayName: entry.name, accentColor: directoryAccent, countLabel: folderCountLabel(entry), cut: cutPaths?.has(entry.relativePath), selected: selected(entry), preSelected: preSelected(entry), selectionMode: selectionMode && !isDownloads(entry) }"
          data-layout-role="card" :data-layout-key="entryObjectId(entry)"
          :runtime-id="entryObjectId(entry)" :runtime-surface-id="runtimeSurfaceId"
          :runtime-selected="selected(entry)" :data-path-folder="isDownloads(entry) ? undefined : entry.relativePath"
          :runtime-abilities="isDownloads(entry) ? [] : ['move']"
          :runtime-target="entryDropTarget(entry)"
          role="button" tabindex="0" @pointerdown="beginCardDrag(entry, $event)" @click.stop="openEntry(entry, $event)"
          @contextmenu.prevent.stop="openContext(entry, $event)"
          @keydown.enter.self.prevent="openEntry(entry, $event)" @keydown.space.self.prevent="openEntry(entry, $event)">
          <template #icon>
            <Icon v-if="isDownloads(entry)" name="action.download" class="fd-big-icon" :size="92" />
            <component v-else :is="directoryIcon" class="fd-big-icon" :size="92" />
          </template>
          <template #name>
            <RenameInput v-if="renamingPath === entry.relativePath" v-model="renameName" @commit="commitRename(entry)" @cancel="cancelRename" />
            <template v-else>{{ entry.name }}</template>
          </template>
          <template #actions>
            <button v-if="!isDownloads(entry)" type="button" class="file-card-btn" :title="t('sharedUi.rename')"
              :aria-label="t('sharedUi.rename')" @pointerdown.stop @click.stop="startRename(entry)"><Icon name="action.edit" :size="11" /></button>
            <button v-if="!isDownloads(entry)" type="button" class="file-card-btn del" :title="t('sharedUi.moveToTrash')"
              :aria-label="t('sharedUi.moveToTrash')" @pointerdown.stop @click.stop="emit('trash', entry)">
              <Icon name="action.delete" :size="11" />
            </button>
          </template>
        </RuntimeFolderCard>
        <RuntimeFileCard v-else
          :card-props="{ ext: fileName(entry).ext, displayName: fileName(entry).base, hasThumb: !!thumbnailUrl(entry), cut: cutPaths?.has(entry.relativePath), selected: selected(entry), preSelected: preSelected(entry), selectionMode }"
          data-layout-role="card" :data-layout-key="entryObjectId(entry)"
          :runtime-id="entryObjectId(entry)" :runtime-surface-id="runtimeSurfaceId" :data-path-file="entry.relativePath" :runtime-selected="selected(entry)" role="group"
          @pointerdown="beginCardDrag(entry, $event)" @click.stop="openEntry(entry, $event)" @contextmenu.prevent.stop="openContext(entry, $event)">
          <template #name>
            <RenameInput v-if="renamingPath === entry.relativePath" v-model="renameName" @commit="commitRename(entry)" @cancel="cancelRename" />
            <button v-else type="button" class="workspace-file-open" :aria-label="entry.name"
              @click.stop="openEntry(entry, $event)">{{ fileName(entry).base }}</button>
          </template>
          <template #thumb>
            <img :src="thumbnailUrl(entry)" loading="lazy" decoding="async" draggable="false" alt=""
              @error="failedThumbnails.add(entry.relativePath)" />
          </template>
          <template #meta>{{ fmtBytes(entry.size) }}</template>
          <div v-if="!selectionMode" class="file-card-hover-actions">
            <button type="button" class="file-card-btn" :title="t('sharedUi.rename')"
              :aria-label="t('sharedUi.rename')" @pointerdown.stop @click.stop="startRename(entry)"><Icon name="action.edit" :size="11" /></button>
            <button v-if="!fileOpenAccess" type="button" class="file-card-btn" :title="t('common.actions.download')"
              :aria-label="t('common.actions.download')" @pointerdown.stop @click.stop="download(entry)">
              <Icon name="action.download" :size="11" />
            </button>
            <button type="button" class="file-card-btn del" :title="t('sharedUi.moveToTrash')"
              :aria-label="t('sharedUi.moveToTrash')" @pointerdown.stop @click.stop="emit('trash', entry)">
              <Icon name="action.delete" :size="11" />
            </button>
          </div>
        </RuntimeFileCard>
      </template>
      <FileUploadGhostCard v-for="ghost in uploadingItems" :key="ghost.uid" data-flip-target
        :name="ghost.name" :ext="ghost.ext" :progress="ghost.progress" :error="ghost.error" />
      <FileUploadButton :label="fileOpenAccess ? t('filesUi.addDesktopFile') : undefined" data-flip-target @select="selectFiles" />
    </FileBrowserGrid>
    <FileBrowserContextMenu :show="!!contextEntry" :x="contextX" :y="contextY" @close="contextEntry = null">
      <template v-if="contextEntry">
        <template v-if="contextEntry.kind === 'file' && fileOpenAccess?.canOpenInSystem(fileTarget(contextEntry))">
          <button type="button" class="ctx-item popup-menu-item" @click="runContext(previewFile)">
            <Icon name="action.expand" :size="13" />{{ t('filesUi.previewInGugu') }}
          </button>
          <button type="button" class="ctx-item popup-menu-item" @click="runContext(entry => fileOpenAccess?.openInSystem(fileTarget(entry)))">
            <Icon name="file.folder-open" :size="13" />{{ t('filesUi.openInSystem') }}
          </button>
        </template>
        <button v-if="!fileOpenAccess && contextEntry.kind === 'file'" type="button" class="ctx-item popup-menu-item"
          @click="runContext(download)"><Icon name="action.download" :size="13" />{{ t('sharedUi.download') }}</button>
        <button type="button" class="ctx-item popup-menu-item"
          @click="runContext(startRename)"><Icon name="action.edit" :size="13" />{{ t('sharedUi.rename') }}</button>
        <button type="button" class="ctx-item popup-menu-item"
          @click="runContext(entry => emit('cut', entry))"><Icon name="action.cut" :size="13" />{{ t('sharedUi.cut') }}</button>
        <button type="button" class="ctx-item popup-menu-item danger"
          @click="runContext(entry => emit('trash', entry))"><Icon name="action.delete" :size="13" />{{ t('sharedUi.moveToTrash') }}</button>
      </template>
    </FileBrowserContextMenu>
    <UploadConflictDialog ref="conflictDialog" />
  </section>
</template>

<script setup lang="ts">
import SkeletonGate from '@/components/common/feedback/skeleton/SkeletonGate.vue'
import PageSkeleton from '@/components/common/feedback/skeleton/PageSkeleton.vue'

import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
import FileBrowserContextMenu from '@/components/common/file-browser/FileBrowserContextMenu.vue'
import FileBrowserGrid from '@/components/common/file-browser/FileBrowserGrid.vue'
import FileBrowserList from '@/components/common/file-browser/FileBrowserList.vue'
import RuntimeFileCard from '@/components/common/file-browser/RuntimeFileCard.vue'
import RuntimeFolderCard from '@/components/common/file-browser/RuntimeFolderCard.vue'
import RuntimeListRow from '@/components/common/file-browser/RuntimeListRow.vue'
import FileUploadButton from '@/components/common/file-browser/FileUploadButton.vue'
import FileUploadGhostCard from '@/components/common/file-browser/FileUploadGhostCard.vue'
import RenameInput from '@/components/common/file-browser/RenameInput.vue'
import Icon from '@/components/common/icons/Icon.vue'
import UploadConflictDialog from '@/components/common/overlays/UploadConflictDialog.vue'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import { filesToItems, readDroppedEntries, uploadWorkspaceFile, type UploadItem } from '@/composables/files/useFileUploadCore'
import { useDesktopFileDrag } from '@/composables/files/useDesktopFileDrag'
import { useFileLibraryFolderPresentation } from '@/composables/files/useFileLibraryFolderPresentation'
import type { usePathFileSelection } from '@/composables/files/usePathFileSelection'
import { fileObjectId, folderSurfaceId } from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'
import type { TargetItem } from '@/interaction/runtime'
import { useUploadQueue } from '@/composables/shared/useUploadQueue'
import { type PathDirectory, type PathFileEntry } from '@/services/api'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { isPreviewable, usePreviewStore } from '@/stores/preview'
import { shouldOpenFileInSystem } from '@/utils/filePreviewTypes'
import { useFileOpenAccess } from '@/services/fileOpenAccess'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { fmtBytes } from '@/utils/fileSize'
import { splitName } from '@/utils/fileParse'
import { fileIconColor, fileListIcon } from '@/utils/fileTypes'

const pathFilesApi = usePathFileAccess()

const props = defineProps<{
  directoryId: PathDirectory
  runtimeSurfaceId: string
  relativePath: string
  viewMode: 'grid' | 'list'
  sortKey: string
  sortDir: 'asc' | 'desc'
  reload: number
  cutPaths?: ReadonlySet<string>
  selectionMode?: boolean
  nativeFileDrag?: boolean
  selectedPaths?: ReadonlySet<string>
  previewPaths?: ReadonlySet<string>
}>()
const emit = defineEmits<{
  openDirectory: [entry: PathFileEntry]
  sortSelect: [key: string]
  cut: [entry: PathFileEntry]
  trash: [entry: PathFileEntry]
  select: [entry: PathFileEntry, event: MouseEvent | KeyboardEvent]
  renamed: []
}>()
const fileOpenAccess = useFileOpenAccess()
const { t } = useI18n()
const { folderListIcon, folderAccentColor } = useFileLibraryFolderPresentation()
const directoryIcon = folderListIcon({ type: 'folder' })
const directoryAccent = folderAccentColor({ type: 'folder' })
const previewStore = usePreviewStore()
const entries = ref<PathFileEntry[]>([])
const failedThumbnails = ref(new Set<string>())
watch(entries, () => failedThumbnails.value.clear())

function thumbnailUrl(entry: PathFileEntry) {
  if (!entry.mimeType?.startsWith('image/') || entry.size === 0 || entry.size > 8 * 1024 * 1024
    || failedThumbnails.value.has(entry.relativePath)) return undefined
  return pathFilesApi.thumbnailUrl(fileTarget(entry))
}
const loading = ref(false)
const pending = ref(false)
let loadingTimer: ReturnType<typeof setTimeout> | undefined
let previousLocation: { directory: PathDirectory; path: string; epoch: number } | undefined
const error = ref('')
const renamingPath = ref('')
const renameName = ref('')
const renaming = ref(false)
const contextEntry = ref<PathFileEntry | null>(null)
const contextX = ref(0)
const contextY = ref(0)
const { uploadingItems, createGhost, updateGhostProgress, removeGhost, failGhost } = useUploadQueue()
let request = 0
const downloadsPath = '下载'
const isPersonalRoot = computed(() => props.directoryId === 'personal' && props.relativePath === '')
function isDownloads(entry: PathFileEntry) {
  return isPersonalRoot.value && entry.kind === 'directory' && entry.relativePath === downloadsPath
}

function folderCountLabel(entry: PathFileEntry) {
  if (entry.fileCount === undefined || entry.folderCount === undefined) return '—'
  return t('filesViewUi.folderContents', { files: entry.fileCount, folders: entry.folderCount })
}

const sortColumns = ['name', 'type', 'size'] as const
const sortedEntries = computed(() => [...entries.value].sort((a, b) => {
  const pinned = Number(isDownloads(b)) - Number(isDownloads(a))
  if (pinned) return pinned
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  const difference = props.sortKey === 'size' ? a.size - b.size
    : props.sortKey === 'type' && a.kind === 'file' ? fileName(a).ext.localeCompare(fileName(b).ext) : 0
  return (difference || a.name.localeCompare(b.name, undefined, { numeric: true })) * (props.sortDir === 'desc' ? -1 : 1)
}))

async function load() {
  const generation = ++request
  const location = { directory: props.directoryId, path: props.relativePath, epoch: accountBoundaryEpoch.value }
  if (previousLocation?.directory !== location.directory || previousLocation.path !== location.path
    || previousLocation.epoch !== location.epoch) entries.value = []
  previousLocation = location
  clearTimeout(loadingTimer)
  loading.value = false
  pending.value = true
  error.value = ''
  if (!entries.value.length) loadingTimer = setTimeout(() => { loading.value = true }, 180)
  try {
    let listed = await pathFilesApi.entries(location.directory, location.path)
    if (generation !== request) return
    if (isPersonalRoot.value && !listed.some(isDownloads)) {
      let creationError: unknown
      try {
        await pathFilesApi.createFolder({ directoryId: 'personal', relativePath: downloadsPath })
      } catch (cause) {
        creationError = cause
      }
      if (generation !== request) return
      // 另一标签页或下载工具也可能在此时创建同一目录。
      listed = await pathFilesApi.entries('personal')
      if (generation === request && creationError && !listed.some(isDownloads))
        showAppError(errorMessage(creationError))
    }
    if (generation === request) entries.value = listed
  } catch (cause) {
    if (generation === request) error.value = errorMessage(cause)
  } finally {
    if (generation === request) {
      clearTimeout(loadingTimer)
      loading.value = false
      pending.value = false
    }
  }
}

watch([() => props.directoryId, () => props.relativePath, () => props.reload, accountBoundaryEpoch], load, { immediate: true })
watch([() => props.directoryId, () => props.relativePath, accountBoundaryEpoch], () => {
  cancelRename()
  contextEntry.value = null
})
onScopeDispose(() => { request++; clearTimeout(loadingTimer) })

function selected(entry: PathFileEntry) { return props.selectedPaths?.has(entry.relativePath) ?? false }
function preSelected(entry: PathFileEntry) { return props.previewPaths?.has(entry.relativePath) ?? false }
function selectedEntries() { return sortedEntries.value.filter(selected) }

function openContext(entry: PathFileEntry, event: MouseEvent) {
  if (isDownloads(entry)) return
  contextX.value = event.clientX
  contextY.value = event.clientY
  contextEntry.value = entry
}

function runContext(action: (entry: PathFileEntry) => void) {
  const entry = contextEntry.value
  contextEntry.value = null
  if (entry) action(entry)
}

function startRename(entry: PathFileEntry) {
  renamingPath.value = entry.relativePath
  renameName.value = entry.name
}

function cancelRename() { renamingPath.value = '' }

async function commitRename(entry: PathFileEntry) {
  if (renamingPath.value !== entry.relativePath || renaming.value) return
  const name = renameName.value.trim()
  if (!name || name === entry.name) { cancelRename(); return }
  if (/[\/\\]/.test(name)) { showAppError(t('projects.invalidName')); return }
  const directoryId = props.directoryId
  const destination = [props.relativePath, name].filter(Boolean).join('/')
  renaming.value = true
  try {
    await pathFilesApi.move({ directoryId, relativePath: entry.relativePath }, destination)
    cancelRename()
    emit('renamed')
    void load()
  } catch (cause) {
    showAppError(errorMessage(cause))
  } finally {
    renaming.value = false
  }
}

const conflictDialog = ref<InstanceType<typeof UploadConflictDialog> | null>(null)

async function uploadItems(items: UploadItem[]) {
  const target = { directoryId: props.directoryId, relativePath: props.relativePath }
  const epoch = accountBoundaryEpoch.value
  for (const item of items) {
    if (epoch !== accountBoundaryEpoch.value) return
    const { base, ext } = splitName(item.file.name)
    const ghost = createGhost(base || item.file.name, ext)
    try {
      await uploadWorkspaceFile(target, item, progress => updateGhostProgress(ghost, progress),
        conflicts => conflictDialog.value?.show(conflicts) ?? Promise.resolve(new Map()),
        () => epoch === accountBoundaryEpoch.value, pathFilesApi)
      removeGhost(ghost)
    } catch (cause) {
      failGhost(ghost)
      showAppError(errorMessage(cause))
    }
  }
  if (items.length && epoch === accountBoundaryEpoch.value && target.directoryId === props.directoryId
    && target.relativePath === props.relativePath) void load()
}

function selectFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const items = filesToItems(input.files ?? [])
  input.value = ''
  void uploadItems(items)
}

async function handleDrop(event: DragEvent) {
  if (event.dataTransfer) await uploadItems(await readDroppedEntries(event.dataTransfer))
}

function entryObjectId(entry: PathFileEntry) {
  return fileObjectId(props.runtimeSurfaceId, entry.kind === 'directory' ? 'folder' : 'file', `${props.directoryId}:${entry.relativePath}`)
}

function directorySurfaceId(entry: PathFileEntry) {
  return folderSurfaceId(props.runtimeSurfaceId, `${props.directoryId}:${entry.relativePath}`)
}

function entryDropTarget(entry: PathFileEntry): Omit<TargetItem, 'id' | 'element' | 'generation'> | undefined {
  if (entry.kind !== 'directory') return
  return { surfaceId: directorySurfaceId(entry), accepts: ['file-item', 'folder-item'], priority: 2 }
}

async function handleMoveAction(
  objectIds: readonly string[],
  surfaceId: string,
  moveInto: ReturnType<typeof usePathFileSelection>['moveInto'],
  ancestorPath?: string,
) {
  const destination = ancestorPath ?? entries.value.find(entry => entry.kind === 'directory' && directorySurfaceId(entry) === surfaceId)?.relativePath
  if (destination === undefined || destination === props.relativePath) return
  const sources = entries.value.filter(entry => !isDownloads(entry) && objectIds.includes(entryObjectId(entry)))
  if (!sources.length || sources.some(entry => entry.relativePath === destination || destination.startsWith(`${entry.relativePath}/`))) return
  // 布局事务要在目录刷新并渲染后读取兄弟卡片和上传入口的最终位置。
  await moveInto(sources, destination, async () => {
    await load()
    await nextTick()
  })
}

defineExpose({ handleDrop, handleMoveAction, selectedEntries })

function download(entry: PathFileEntry) {
  void pathFilesApi.download({ directoryId: props.directoryId, relativePath: entry.relativePath }).catch(error => showAppError(errorMessage(error)))
}

function fileName(entry: PathFileEntry) {
  const { base, ext } = splitName(entry.name)
  return base ? { base, ext } : { base: entry.name, ext: '' }
}

function openEntry(entry: PathFileEntry, event: MouseEvent | KeyboardEvent) {
  if (isDownloads(entry)) { emit('openDirectory', entry); return }
  if (props.selectionMode || event.ctrlKey || event.metaKey || event.shiftKey) {
    emit('select', entry, event)
    return
  }
  if (entry.kind === 'directory') emit('openDirectory', entry)
  else openFile(entry)
}

const trackDesktopDrag = useDesktopFileDrag()
function beginCardDrag(entry: PathFileEntry, event: PointerEvent) {
  const directoryId = props.directoryId
  const startNativeDrag = fileOpenAccess?.startNativeDrag
  if (!props.nativeFileDrag || !startNativeDrag || typeof directoryId !== 'string'
    || renamingPath.value === entry.relativePath || isDownloads(entry)) return
  trackDesktopDrag(event, entryObjectId(entry), preview => {
    void startNativeDrag(directoryId, entry.relativePath, preview)
      .catch(error => showAppError(errorMessage(error, t('filesUi.dragDesktopFileFailed'))))
  })
}

function fileTarget(entry: PathFileEntry) {
  return { directoryId: props.directoryId, relativePath: entry.relativePath }
}

function openFile(entry: PathFileEntry) {
  const file = fileTarget(entry)
  const { ext } = fileName(entry)
  if (fileOpenAccess) {
    if (!fileOpenAccess?.canOpenInSystem(file)) return previewFile(entry)
    if (shouldOpenFileInSystem(fileOpenAccess.getOpenPreference(), ext, entry.mimeType))
      return void fileOpenAccess?.openInSystem(file)
  } else if (!isPreviewable(ext, entry.mimeType)) return download(entry)
  previewFile(entry)
}

function previewFile(entry: PathFileEntry) {
  const { base, ext } = fileName(entry)
  previewStore.open({
    displayName: base,
    ext, mimeType: entry.mimeType, sizeBytes: entry.size,
    workspaceFile: fileTarget(entry),
  }, null, true)
}
</script>

<style scoped>

.workspace-file-list :is(.list-head, .list-row) {
  grid-template-columns: minmax(0, 1fr) 64px 72px 34px;
}
.workspace-file-open {
  max-width: 100%; padding: 0; border: 0; background: none; color: inherit; font: inherit;
  text-align: start; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
}
.fc-card:focus-within .file-card-hover-actions { opacity: 1; pointer-events: auto; }
.folder-card:focus-within :deep(.file-card-hover-actions) { opacity: 1; pointer-events: auto; }
.list-row:focus-within .file-list-btn { opacity: 1; }
</style>
