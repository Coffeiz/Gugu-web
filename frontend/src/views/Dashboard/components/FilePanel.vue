<template>
  <div class="glass-card file-panel">
    <div class="section-header">
      <span class="section-title">最近文件</span>
    </div>

    <!-- 文件网格 -->
    <div class="file-grid">
      <div
        v-for="f in files"
        :key="f.id"
        class="file-card"
      >
        <div class="card-top">
          <span class="file-ext">{{ f.type }}</span>
          <span class="proj-dot" :style="{ background: f.color }" :title="f.project"></span>
        </div>
        <div class="file-name">{{ f.name }}</div>
        <div class="file-bottom">
          <span class="file-project">{{ f.project }}</span>
          <span class="file-meta">{{ f.size }} · {{ f.date }}</span>
        </div>
      </div>

      <!-- 上传区 -->
      <div
        class="file-upload"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="dragging = false; openUpload()"
        :class="{ dragging }"
        @click="openUpload"
      >
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 12V3M5 7l4-4 4 4"/><path d="M2 14h14"/>
        </svg>
        <span>上传文件</span>
      </div>

    </div>
  </div>

  <Teleport to="body">
    <UploadModal
      :show="uploadOpen"
      :projects="projects"
      @close="uploadOpen = false"
      @uploaded="onUploaded"
    />
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { filesApi } from '@/services/api'
import { filesCache } from '@/services/cache'
import { useProjectStore } from '@/stores/projects'
import UploadModal from '@/views/Files/UploadModal.vue'

const dragging    = ref(false)
const uploadOpen  = ref(false)
const rawFiles    = ref(filesCache.data ?? [])
const projectStore = useProjectStore()
const projects     = computed(() => projectStore.projects)

function openUpload() { uploadOpen.value = true }

async function onUploaded() {
  uploadOpen.value = false
  try {
    const fresh = await filesApi.list()
    filesCache.data = fresh
    rawFiles.value = fresh
  } catch { /* ignore */ }
}

onMounted(async () => {
  try {
    const fresh = await filesApi.list()
    filesCache.data = fresh
    rawFiles.value = fresh
  } catch { /* ignore */ }
})

const files = computed(() =>
  rawFiles.value.slice(0, 6).map(f => ({
    id:      f.id,
    name:    f.displayName,
    type:    f.ext,
    size:    f.versions?.[0]?.size ?? '—',
    date:    f.versions?.[0]?.date ?? '—',
    project: f.projectName ?? '未分类',
    color:   f.projectColor ?? '#8a8fa8',
  }))
)
</script>

<style scoped>
.file-panel { padding: 20px; flex-shrink: 0; }

.file-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 8px;
  align-content: start;
}

.file-card {
  background: rgba(255,255,255,0.68);
  border: 1px solid rgba(255,255,255,0.85);
  border-radius: var(--radius-md);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 4px rgba(80,90,110,0.05);
  padding: 9px 10px 8px;
  cursor: pointer;
  display: flex; flex-direction: column; gap: 4px;
  transition: transform 0.3s cubic-bezier(0.34, 1.2, 0.64, 1),
              box-shadow 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              background 0.25s ease-out;
}
.file-card:hover {
  transform: translateY(-2px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 6px 16px rgba(80,90,110,0.11);
  background: rgba(255,255,255,0.82);
}
.file-card:active { transform: translateY(1px); opacity: 0.93; }

.card-top {
  display: flex; align-items: center; justify-content: space-between;
}

.file-ext {
  font-size: 9px; font-weight: 800; letter-spacing: 0.04em;
  color: var(--color-primary);
  background: rgba(123,127,178,0.12);
  border-radius: 4px; padding: 2px 5px;
}

.proj-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  opacity: 0.8;
}

.file-name {
  font-size: 11px; font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.3; padding-bottom: 2px; margin-bottom: -2px;
}

.file-bottom {
  display: flex; flex-direction: column; gap: 1px;
}
.file-project {
  font-size: 10px; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-bottom: 2px; margin-bottom: -2px;
}
.file-meta {
  font-size: 9px; color: var(--text-secondary); opacity: 0.7;
}

.file-upload {
  border: 1.5px dashed rgba(0,0,0,0.1);
  border-radius: var(--radius-md);
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 5px;
  min-height: 80px;
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
  background: rgba(255,255,255,0.2);
  transition: all 0.18s;
}
.file-upload:hover, .file-upload.dragging {
  border-color: rgba(123,127,178,0.5);
  color: var(--color-primary);
  background: rgba(123,127,178,0.05);
}
</style>
