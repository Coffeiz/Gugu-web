<template>
  <!-- 画布本体铺满整个浏览器（含侧栏背后，见 MindCanvas.vue），但这条工具条是浮层 UI，
       不能居中到整个浏览器宽度——那样会有一半视觉重心撞进侧栏底下看不见的那块。加回侧栏
       宽度一半的偏移，实际居中在「侧栏右缘到视口右缘」这段真正看得见的区域里。 -->
  <div class="canvas-toolbar-wrap" @pointerdown.stop>
    <PopupMenu :show="pickerOpen" :anchor="toolbarRef" placement="top" popup-class="note-picker-host">
      <section class="note-picker glass-card">
        <div class="np-head"><span>添加项目、文件或活动</span><button title="关闭" @click="pickerOpen = false"><PhX :size="14" weight="bold" /></button></div>
        <input v-model="refQuery" class="np-search" placeholder="搜索项目、文件、活动" autofocus />
        <button v-for="ref in refResults" :key="`${ref.type}-${ref.id}`" class="np-note" @click="pickRef(ref)">
          <strong>{{ ref.label }}</strong><span>{{ refTypeLabel(ref.type) }}{{ ref.subtitle ? ` · ${ref.subtitle}` : '' }}</span>
        </button>
        <div v-if="refQuery && !refResults.length" class="np-empty">没有找到可添加的对象</div>
      </section>
    </PopupMenu>

    <!-- 底部药丸样横条：新建便签 / 添加对象引用 / 缩放（要求 1：底部药丸横条工具栏） -->
    <div ref="toolbarRef" class="canvas-toolbar glass-card">
      <button title="新建画布便签" @click="emit('createNote')"><PhNotePencil :size="16" weight="bold" /></button>
      <button title="添加项目、文件或活动" :class="{ active: pickerOpen }" @click="togglePicker"><PhPlus :size="16" weight="bold" /></button>
      <span class="tool-divider"></span>
      <button title="缩小" @click="emit('zoom', -0.12)"><PhMinus :size="15" weight="bold" /></button>
      <button title="恢复 100%" class="zoom-label" @click="emit('resetView')">{{ Math.round(scale * 100) }}%</button>
      <button title="放大" @click="emit('zoom', 0.12)"><PhPlus :size="15" weight="bold" /></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { PhMinus, PhNotePencil, PhPlus, PhX } from '@phosphor-icons/vue'
import type { MindRefSuggestItem } from '@/services/api'
import { mindApi } from '@/services/api'
import PopupMenu from '@/components/common/PopupMenu.vue'

type CanvasRefItem = MindRefSuggestItem & { type: 'project' | 'file' | 'event' }

defineProps<{ scale: number }>()
const emit = defineEmits<{
  (e: 'createNote'): void
  (e: 'addRef', ref: CanvasRefItem): void
  (e: 'zoom', delta: number): void
  (e: 'resetView'): void
}>()

const pickerOpen = ref(false)
const toolbarRef = ref<HTMLElement | null>(null)
const refQuery = ref('')
const refResults = ref<CanvasRefItem[]>([])

function togglePicker() {
  pickerOpen.value = !pickerOpen.value
  refQuery.value = ''
}
watch(refQuery, async (query) => {
  const value = query.trim()
  // ref-suggest 也搜对话（笔记 @ 引用用），画布图层节点还不支持接对话，过滤掉——
  // 不然会出现选了却建不出节点的选项。
  refResults.value = value
    ? (await mindApi.refSuggest(value)).filter((it): it is CanvasRefItem => it.type !== 'conversation')
    : []
})
function pickRef(item: CanvasRefItem) {
  emit('addRef', item)
  pickerOpen.value = false
  refQuery.value = ''
}
function refTypeLabel(type: CanvasRefItem['type']) {
  return ({ project: '项目', file: '文件', event: '活动' }[type])
}
</script>

<style scoped>
/* 居中基准是「侧栏右缘～视口右缘」这段可见区域的中点（50% + 侧栏宽一半），
   不是整个浏览器视口的中点——跟笔记页捕捉条（活在侧栏右侧的正常文档流里，天然只在
   可见区域居中）对齐到同一条竖直线上。bottom:28px 与笔记页捕捉条 .rec-capture 一致。 */
.canvas-toolbar-wrap {
  position: absolute; left: calc(50% + var(--sidebar-width) / 2); bottom: var(--floating-edge); z-index: 40;
  transform: translateX(-50%);
}
/* 真正的药丸：corner-shape 显式覆盖成 round——.glass-card 全局默认是 squircle（连续曲率），
   在这种高度矮、圆角占满整条边的胶囊上，squircle 的数学反而把两端"挤"成圆角矩形，不是纯圆头。 */
.canvas-toolbar { position: relative; display: flex; align-items: center; height: var(--canvas-toolbar-height); padding: 0 7px; border-radius: 999px; corner-shape: round; }
.canvas-toolbar button { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border: 0; border-radius: 999px; background: none; color: var(--text-secondary); cursor: pointer; }
.canvas-toolbar button:hover { color: var(--color-primary); background: rgba(123,127,178,.11); }
.canvas-toolbar button.active { background: rgba(123,127,178,.15); color: var(--color-primary); }
.canvas-toolbar .zoom-label { width: 45px; font-size: 11px; font-weight: 700; }
.tool-divider { width: 1px; height: 17px; margin: 0 4px; background: rgba(123,127,178,.18); }

:global(.popup-menu-host.note-picker-host) { padding: 0; border: 0; background: transparent; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
.note-picker { width: 270px; max-height: 390px; overflow: auto; padding: 10px; }
.np-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 8px; color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.np-head button { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 0; border-radius: 5px; background: none; color: var(--text-secondary); cursor: pointer; }
.np-head button:hover { color: var(--color-primary); background: rgba(123,127,178,.11); }
.np-search { width: 100%; height: 31px; box-sizing: border-box; margin: 0 0 6px; padding: 0 9px; border: 1px solid rgba(123,127,178,.15); border-radius: 6px; outline: 0; background: rgba(255,255,255,.56); color: var(--text-primary); font: inherit; font-size: 11.5px; }
.np-search:focus { border-color: rgba(123,127,178,.45); background: rgba(255,255,255,.8); }
.np-note { display: flex; flex-direction: column; gap: 3px; width: 100%; padding: 9px; border: 0; border-radius: 6px; background: none; color: var(--text-primary); text-align: left; cursor: pointer; }
.np-note:hover { background: rgba(255,255,255,.72); }
.np-note strong, .np-note span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.np-note strong { font-size: 12px; }
.np-note span, .np-empty { color: var(--text-secondary); font-size: 11px; }
.np-empty { padding: 18px 8px; text-align: center; }
</style>
