<template>
  <!-- 画布本体铺满整个浏览器（含侧栏背后，见 MindCanvas.vue），但这条工具条是浮层 UI，
       不能居中到整个浏览器宽度——那样会有一半视觉重心撞进侧栏底下看不见的那块。加回侧栏
       宽度一半的偏移，实际居中在「侧栏右缘到视口右缘」这段真正看得见的区域里。 -->
  <div class="canvas-toolbar-wrap" @pointerdown.stop>
    <PopupMenu :show="pickerOpen" :anchor="toolbarRef" :style="{ padding: 0 }" placement="top" popup-class="note-picker-host">
      <section class="note-picker glass-card">
        <div class="np-head"><span>{{ t('mindUi.addObject') }}</span><button :title="t('mindUi.close')" @click="pickerOpen = false"><PhX :size="14" weight="bold" /></button></div>
        <input v-model="refQuery" class="np-search" :placeholder="t('mindUi.searchObjects')" autofocus />
        <div class="np-results">
          <button v-for="ref in refResults" :key="`${ref.type}-${ref.id}`" class="np-note" @click="pickRef(ref)">
            <strong>{{ ref.label }}</strong><span>{{ refTypeLabel(ref.type) }}{{ ref.subtitle ? ` · ${ref.subtitle}` : '' }}</span>
          </button>
          <div v-if="refQuery && !refResults.length" class="np-empty">{{ t('mindUi.noObjects') }}</div>
        </div>
      </section>
    </PopupMenu>

    <PopupMenu :show="locateOpen" :anchor="toolbarRef" :style="{ padding: 0 }" placement="top" popup-class="note-picker-host">
      <section class="note-picker glass-card">
        <div class="np-head"><span>{{ t('mindUi.locateCanvasCard') }}</span><button :title="t('mindUi.close')" @click="locateOpen = false"><PhX :size="14" weight="bold" /></button></div>
        <input v-model="cardQuery" class="np-search" :aria-label="t('mindUi.searchCanvasCards')" :placeholder="t('mindUi.searchCanvasCards')" autofocus />
        <div ref="cardResultsEl" class="np-results">
          <button v-for="item in cardResults" :key="item.canvasId + '-' + item.nodeId" class="np-note" @click="locateCard(item.nodeId)">
            <strong>{{ cardTitle(item) }}</strong><span>{{ cardType(item) }}</span>
          </button>
          <div v-if="!cardResults.length" class="np-empty">{{ t('mindUi.noCanvasCards') }}</div>
        </div>
      </section>
    </PopupMenu>

    <!-- 底部药丸样横条：新建便签 / 添加对象引用 / 缩放（要求 1：底部药丸横条工具栏） -->
    <div ref="toolbarRef" class="canvas-toolbar glass-card">
      <button :title="t('mindUi.newCanvasNote')" @click="emit('createNote')"><PhNotePencil :size="16" weight="bold" /></button>
      <button :title="t('mindUi.addObject')" :class="{ active: pickerOpen }" @click="togglePicker"><PhPlus :size="16" weight="bold" /></button>
      <span class="tool-divider"></span>
      <button :title="t('mindUi.zoomOut')" @click="emit('zoom', -0.12)"><PhMinus :size="15" weight="bold" /></button>
      <button :title="t('mindUi.resetZoom')" class="zoom-label" @click="emit('resetView')">{{ Math.round(scale * 100) }}%</button>
      <button :title="t('mindUi.zoomIn')" @click="emit('zoom', 0.12)"><PhPlus :size="15" weight="bold" /></button>
      <span class="tool-divider"></span>
      <button :title="t('mindUi.locateCanvasCard')" :class="{ active: locateOpen }" @click="toggleLocate"><RiMapPin2Line class="ri-map-pin-2-line" size="16" /></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhMinus, PhNotePencil, PhPlus, PhX } from '@phosphor-icons/vue'
import { RiMapPin2Line } from '@remixicon/vue'
import type { MindCanvasItem, MindRefSuggestItem } from '@/services/api'
import { splitMindTitleBody } from '@/composables/mind/useMindEditor'
import { mindApi } from '@/services/api'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'

type CanvasRefItem = MindRefSuggestItem & { type: 'project' | 'file' | 'event' }

const props = defineProps<{ scale: number; items: MindCanvasItem[] }>()
const emit = defineEmits<{
  (e: 'createNote'): void
  (e: 'addRef', ref: CanvasRefItem): void
  (e: 'zoom', delta: number): void
  (e: 'resetView'): void
  (e: 'locateCard', nodeId: number): void
}>()
const { t } = useI18n()

const pickerOpen = ref(false)
const toolbarRef = ref<HTMLElement | null>(null)
const refQuery = ref('')
const refResults = ref<CanvasRefItem[]>([])
const locateOpen = ref(false)
const cardQuery = ref('')
const cardResultsEl = ref<HTMLElement | null>(null)
const cardResults = computed(() => {
  const query = cardQuery.value.trim().toLocaleLowerCase()
  return props.items.filter(item => {
    const searchable = [
      item.node.title,
      item.node.contentMd,
      item.node.refType,
      item.refData?.description,
      item.refData?.date,
    ].filter(Boolean).join('\n').toLocaleLowerCase()
    return !query || searchable.includes(query)
  })
})

function togglePicker() {
  pickerOpen.value = !pickerOpen.value
  locateOpen.value = false
  refQuery.value = ''
}
function toggleLocate() {
  locateOpen.value = !locateOpen.value
  pickerOpen.value = false
  cardQuery.value = ''
  if (locateOpen.value) void nextTick(() => { if (cardResultsEl.value) cardResultsEl.value.scrollTop = 0 })
}
function cardTitle(item: MindCanvasItem) {
  const contentTitle = item.node.kind === 'canvas_note' ? splitMindTitleBody(item.node.contentMd).titleRaw : ''
  return contentTitle || item.node.title || t('mindUi.unnamedObject')
}
function cardType(item: MindCanvasItem) {
  if (item.node.kind === 'canvas_note') return t('mindEditorUi.referenceTypes.canvas_note')
  const refType = item.node.refType || 'event'
  return t('mindEditorUi.referenceTypes.' + refType, t('mindUi.object'))
}
function locateCard(nodeId: number) {
  emit('locateCard', nodeId)
  locateOpen.value = false
  cardQuery.value = ''
}
watch(cardQuery, async () => {
  await nextTick()
  if (cardResultsEl.value) cardResultsEl.value.scrollTop = 0
})
watch(refQuery, async (query) => {
  const value = query.trim()
  // 引用建议还包含文件夹、对话等类型；画布目前只支持项目、文件和活动节点。
  refResults.value = value
    ? (await mindApi.refSuggest(value)).filter((it): it is CanvasRefItem =>
      it.type === 'project' || it.type === 'file' || it.type === 'event',
    )
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

.note-picker { display: flex; flex-direction: column; width: 270px; max-height: 390px; overflow: hidden; padding: 10px; }
.np-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 8px; color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.np-head button { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 0; border-radius: 5px; background: none; color: var(--text-secondary); cursor: pointer; }
.np-head button:hover { color: var(--color-primary); background: rgba(123,127,178,.11); }
.np-search {
  flex: 0 0 auto;
  width: 100%; height: 31px; box-sizing: border-box; margin: 0; padding: 0 9px;
  border: 1px solid var(--input-border); border-radius: 6px; outline: 0;
  background: var(--input-bg); color: var(--input-fg); font: inherit; font-size: 11.5px;
  box-shadow: var(--input-hover-shadow), 0 0 0 0 transparent;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard),
              border-color var(--motion-hover-control) var(--motion-ease-standard),
              box-shadow var(--motion-hover-control) var(--motion-ease-standard),
              color var(--motion-hover-control) var(--motion-ease-standard);
}
.np-search:focus {
  border-color: var(--input-border-focus); background: var(--input-bg-focus);
  box-shadow: var(--input-hover-shadow), var(--input-focus-shadow);
}
.np-results { flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; padding: 0 2px; }
.np-note { display: flex; flex: 0 0 auto; flex-direction: column; gap: 3px; width: 100%; padding: 9px; border: 1px solid transparent; border-radius: 6px; background: none; color: var(--text-primary); text-align: left; cursor: pointer; transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }
.np-note:hover, .np-note:focus-visible { border-color: transparent; background: var(--popup-item-bg-hover); color: var(--content-primary); outline: none; }
.np-note strong, .np-note span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.np-note strong { font-size: 12px; }
.np-note span, .np-empty { color: var(--text-secondary); font-size: 11px; }
.np-empty { padding: 18px 8px; text-align: center; }
</style>
