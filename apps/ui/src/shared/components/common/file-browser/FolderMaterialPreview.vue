<template>
  <div ref="root" class="folder-material-preview" aria-hidden="true">
    <slot v-if="!items.length" />
    <div v-else class="folder-material-samples">
      <span v-for="item in items" :key="item.relativePath" class="folder-material-sample"
        :style="{ color: fileIconColor(item.ext) }">
        <component :is="item.icon" size="19" />
        <img v-if="item.thumbnail && !failed.has(item.relativePath)" :src="item.thumbnail"
          alt="" loading="lazy" decoding="async" draggable="false" @error="failed.add(item.relativePath)" />
      </span>
      <span v-if="remaining > 0" class="folder-material-sample folder-material-more">+{{ remaining }}</span>
    </div>
  </div>
</template>

<script lang="ts">
import { watch as watchAccount, type Component as PreviewIcon } from 'vue'
import { pLimit } from '@/utils/concurrency'
import { accountBoundaryEpoch as previewAccountEpoch } from '@/utils/accountBoundary'
import type { usePathFileAccess as usePreviewFileAccess } from '@/services/pathFileAccess'

const loadFolderPreview = pLimit(4)
type PreviewItem = { relativePath: string; ext: string; icon: PreviewIcon; thumbnail?: string }
type PreviewSnapshot = { items: PreviewItem[]; remaining: number }
type FileAccess = ReturnType<typeof usePreviewFileAccess>
let folderPreviews = new WeakMap<FileAccess, Map<string, PreviewSnapshot>>()
watchAccount(previewAccountEpoch, () => { folderPreviews = new WeakMap() }, { flush: 'sync' })
</script>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { PathDirectory } from '@/services/api'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { fileIconColor, fileListIcon } from '@/utils/fileTypes'
import { resolveIcon } from '@/components/common/icons/iconRegistry'

const props = defineProps<{
  directoryId: PathDirectory
  relativePath: string
  entryCount?: number
  reload: number
}>()
const files = usePathFileAccess()
const root = ref<HTMLElement>()
const visible = ref(false)
const failed = ref(new Set<string>())
const remaining = ref(0)
const items = shallowRef<PreviewItem[]>([])
let observer: IntersectionObserver | undefined
onMounted(() => {
  if (!root.value || typeof IntersectionObserver === 'undefined') {
    visible.value = true
    return
  }
  observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return
    visible.value = true
    observer?.disconnect()
  })
  observer.observe(root.value)
})
onUnmounted(() => observer?.disconnect())

watch([visible, () => props.directoryId, () => props.relativePath, () => props.entryCount,
  () => props.reload, accountBoundaryEpoch], ([show, directoryId, relativePath, count, , epoch], _, onCleanup) => {
  let cache = folderPreviews.get(files)
  if (!cache) { cache = new Map(); folderPreviews.set(files, cache) }
  const key = JSON.stringify([directoryId, relativePath])
  const saved = cache.get(key)
  if (count === 0) cache.delete(key)
  else if (saved) { cache.delete(key); cache.set(key, saved) }
  items.value = count === 0 ? [] : saved?.items ?? []
  remaining.value = count === 0 ? 0 : saved?.remaining ?? 0
  failed.value.clear()
  if (!show || count === 0) return
  let current = true
  onCleanup(() => { current = false })
  void loadFolderPreview(async () => {
    if (!current || epoch !== accountBoundaryEpoch.value) return
    const entries = await files.entries(directoryId, relativePath)
    if (!current || epoch !== accountBoundaryEpoch.value) return
    const isImage = (entry: typeof entries[number]) => entry.kind === 'file'
      && entry.mimeType?.startsWith('image/') && entry.size > 0 && entry.size <= 8 * 1024 * 1024
    items.value = [...entries.filter(isImage), ...entries.filter(entry => !isImage(entry))].slice(0, 3).map(entry => {
      const ext = /\.([^./]+)$/u.exec(entry.name)?.[1] ?? ''
      return {
        relativePath: entry.relativePath, ext,
        icon: entry.kind === 'directory' ? resolveIcon('file.folder') : fileListIcon(ext),
        thumbnail: isImage(entry) ? files.thumbnailUrl({ directoryId, relativePath: entry.relativePath }) : undefined,
      }
    })
    remaining.value = Math.max(0, entries.length - items.value.length)
    cache.set(key, { items: items.value, remaining: remaining.value })
    if (cache.size > 128) cache.delete(cache.keys().next().value!)
  }).catch(() => {
    if (!current || epoch !== accountBoundaryEpoch.value) return
    cache.delete(key)
    items.value = []
    remaining.value = 0
  })
}, { immediate: true })
</script>

<style scoped>
.folder-material-preview { display: grid; place-items: center; width: 100%; pointer-events: none; }
.folder-material-samples {
  inline-size: min(154px, 96%); box-sizing: border-box;
  display: flex; justify-content: center; align-items: center;
  padding: var(--space-xs) var(--space-sm) var(--space-xs);
  mask-image: var(--file-card-media-mask);
}
.folder-material-sample {
  position: relative; display: grid; place-items: center; flex: 0 1 66px;
  min-width: 0; aspect-ratio: 1; box-sizing: border-box; overflow: hidden;
  background: var(--surface-card-solid); border: 1px solid var(--folder-card-border);
  border-radius: var(--radius-xs);
}
.folder-material-sample + .folder-material-sample { margin-inline-start: -25px; }
.folder-material-sample:first-child:not(:only-child) { z-index: 3; transform: translateY(2px) rotate(-14deg); }
.folder-material-sample:nth-child(2) { z-index: 2; transform: translateY(-3px) rotate(-5deg); }
.folder-material-sample:nth-child(3) { z-index: 1; transform: translateY(-3px) rotate(5deg); }
.folder-material-sample:nth-child(4) { transform: translateY(2px) rotate(14deg); }
.folder-material-sample:nth-child(2):last-child,
.folder-material-sample:nth-child(3):last-child { transform: translateY(2px) rotate(14deg); }
.folder-material-sample:nth-child(2):nth-last-child(2) { transform: translateY(-3px); }
.folder-material-sample.folder-material-more {
  border-style: dashed;
  background: var(--surface-soft); color: var(--content-primary);
  justify-items: end; padding-inline-end: var(--space-xs); padding-block-end: var(--space-sm);
  font-size: var(--font-size-xs); font-variant-numeric: tabular-nums;
}
.folder-material-sample > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
</style>
