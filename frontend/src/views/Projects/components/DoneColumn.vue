<template>
  <div
    ref="columnRef"
    class="done-col glass-card"
    data-col-status="done"
    data-column="done"
    data-layout-surface
  >
    <div class="col-header">
      <div class="col-title"><span class="col-dot"></span>已完成</div>
      <div class="col-header-right">
        <button class="archived-entry-mini" @click="$emit('open-archived')" title="查看已归档项目">已归档</button>
        <span class="col-count">{{ projects.length }}</span>
      </div>
    </div>
    <div ref="colBodyRef" class="col-body"><DoneLayout ref="doneLayoutRef" :projects="projects" @card-click="$emit('card-click', $event)" /></div>
  </div>
</template>

<script setup lang="ts">
import { ref, type PropType } from 'vue'
import { useSurface } from '@/interaction/runtime'
import type { Project } from '@/types/project'
import DoneLayout from './done/DoneLayout.vue'

const props = defineProps({ projects: { type: Array as PropType<Project[]>, default: () => [] } })
defineEmits(['card-click', 'open-archived'])
const { elementRef: columnRef } = useSurface({
  id: 'done',
  type: 'project-column',
  accepts: ['project-card'],
  viewport: () => colBodyRef.value,
})
const colBodyRef = ref<HTMLElement | null>(null)
</script>

<style>
.done-col { --glass-bg: rgba(255,255,255,0.25); --glass-bg-hover: rgba(255,255,255,0.25); display:flex; flex-direction:column; padding:12px 10px; gap:8px; min-height:0; overflow:hidden; }
.col-header { display:flex; align-items:center; justify-content:space-between; padding:0 4px; flex-shrink:0; }
.col-title { display:flex; align-items:center; gap:7px; font-size:13px; font-weight:600; color:var(--text-primary); }
.col-dot { width:7px; height:7px; border-radius:50%; background:#5a9e88; flex-shrink:0; }
.col-header-right { display:flex; align-items:center; gap:8px; }
.col-count { font-size:11px; font-weight:700; color:#fff; background:rgba(123,127,178,.42); border-radius:20px; padding:1px 7px; min-width:22px; text-align:center; }
.archived-entry-mini { display:flex; align-items:center; padding:2px 8px; border-radius:7px; border:1px solid rgba(0,0,0,.08); background:rgba(255,255,255,.5); color:var(--text-secondary); font-size:11px; font-weight:600; cursor:pointer; }
.col-body { display:flex; flex-direction:column; gap:2px; flex:1; overflow-y:auto; min-width:0; box-sizing:border-box; overflow-x:hidden; scrollbar-gutter:stable; padding:2px 6px; }
.col-body::-webkit-scrollbar { width:3px; }
.col-body::-webkit-scrollbar-thumb { background:rgba(0,0,0,.1); border-radius:99px; }
.done-layout-root { display:flex; flex-direction:column; width:100%; min-width:0; }
.col-empty { display:flex; align-items:center; justify-content:center; min-height:96px; color:var(--text-secondary); opacity:.4; }
.recent-done { margin-bottom:10px; }
.recent-done-label { display:flex; align-items:center; gap:5px; font-size:11px; font-weight:600; color:#5a9e88; padding:0 2px 6px; }
.month-cards { display:flex; flex-direction:column; gap:6px; padding:4px 0 4px 14px; border-left:1px solid rgba(0,0,0,.06); margin-left:12px; box-sizing:border-box; }
.recent-done .month-cards { border-left:none; margin-left:0; padding:4px 0; }
.done-card-item { flex:0 0 auto; width:100%; }
.year-row,.month-row { display:flex; align-items:center; gap:6px; width:100%; border:0; background:none; cursor:pointer; font-family:var(--font-sans); text-align:left; transition:background .12s; }
.year-row { padding:4px 6px; border-radius:6px; }
.month-row { padding:4px 8px; border-radius:7px; }
.year-row:hover,.month-row:hover { background:rgba(0,0,0,.04); }
.year-chev,.month-chev { color:rgba(0,0,0,.22); transition:transform .2s; flex-shrink:0; }
.year-chev.open,.month-chev.open { transform:rotate(180deg); }
.year-label { font-size:12px; font-weight:700; color:rgba(0,0,0,.62); flex:1; }
.year-label.undated { color:rgba(0,0,0,.4); }
.year-cnt,.month-cnt { font-size:10px; color:rgba(0,0,0,.38); }
.month-name { font-size:11px; font-weight:500; color:rgba(0,0,0,.52); flex:1; }
.month-folder { display:grid; grid-template-rows:1fr; overflow:hidden; transform-origin:top; }
.month-folder-enter-active,.month-folder-leave-active { transition:grid-template-rows .28s cubic-bezier(.22,1,.36,1), opacity .18s ease, transform .28s cubic-bezier(.22,1,.36,1); }
.month-folder-enter-from,.month-folder-leave-to { grid-template-rows:0fr; opacity:0; transform:translateY(-8px) scaleY(.92); }
.done-card-list-enter-active,.done-card-list-leave-active { transition:opacity .22s ease; }
.done-card-list-enter-from,.done-card-list-leave-to { opacity:0; }
</style>
