<template>
  <div class="records">
    <RecordComposer @created="onCreated" />

    <div v-if="store.loading && !store.loaded" class="rec-loading">加载中…</div>
    <RecordTimeline
      v-else
      ref="timelineRef"
      :groups="store.timeline"
      @save="onSave"
      @delete="onDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useLiveStore } from '@/stores/live'
import { MindConflictError, useMindStore } from '@/stores/mind'
import type { MindNote } from '@/services/api'
import RecordComposer from './components/RecordComposer.vue'
import RecordTimeline from './components/RecordTimeline.vue'

const store     = useMindStore()
const liveStore = useLiveStore()
const timelineRef = ref<InstanceType<typeof RecordTimeline> | null>(null)

onMounted(() => { if (!store.loaded) store.fetchNotes() })

// 咕咕/多端改了便签 → 重新拉（P3 后端才开始推 mind 资源，P1 这里先接好）
watch(() => liveStore.rev.mind, () => store.fetchNotes())

async function onCreated(md: string, capturedAt?: string) {
  try {
    await store.createNote({ contentMd: md, capturedAt })
  } catch {
    Message.error('记录失败，请重试')
  }
}

async function onSave(note: MindNote, md: string) {
  try {
    await store.updateNote(note.id, { contentMd: md, version: note.version })
  } catch (e) {
    if (e instanceof MindConflictError) {
      // 乐观锁撞车：别覆盖别人的改动，拉最新回来让用户重看
      timelineRef.value?.flagConflict()
      await store.fetchNotes()
      Message.warning('这条便签已被其他端修改，已刷新为最新内容')
    } else {
      Message.error('保存失败，请重试')
    }
  }
}

async function onDelete(note: MindNote) {
  try {
    await store.deleteNote(note.id)
  } catch {
    Message.error('删除失败，请重试')
  }
}
</script>

<style scoped>
.records { display: flex; flex-direction: column; gap: 18px; max-width: 760px; margin: 0 auto; }
.rec-loading { padding: 40px 0; text-align: center; font-size: 12.5px; color: var(--text-secondary); }
</style>
