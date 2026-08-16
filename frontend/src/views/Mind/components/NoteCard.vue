<template>
  <div ref="cardRef" class="note-card"
       :class="{ editing, highlight, 'nc-edit-pending': editing && !editReady, 'canvas-mode': canvasMode, 'hover-card-fx': canvasMode && !editing, connecting, 'connection-target': !!connectionTargetSide, ['tint-' + (note.color || '')]: !!note.color }"
       :style="{ height: cardHeight }"
       @mouseenter="isHovering = true" @mouseleave="isHovering = false">
    <!-- 编辑态：跟只读态一样按区域分标题区/正文区（不是靠"标题"文字样式段落类型），
         就地展开（跨两列由父级 grid-column 控制）；自动保存，主要退出方式是点卡外面
         （先补一次保存再退出）——但"点外面"这个出口不够显眼（画布上尤其容易让人以为
         点哪都在编辑器范围内，找不到退出的地方），补一个常驻的"完成"按钮兜底。 -->
    <template v-if="editing">
      <input
        ref="titleInputRef" @pointerdown.stop
        v-model="draftTitle" class="nc-title-input" placeholder="标题（可选）"
        @keydown.enter.prevent="bodyEditorRef?.focus()"
      />
      <!-- pendingFocus 有具体目标（标题/某一行）时不让编辑器自己 autofocus:'end'——它内部的
           自动聚焦是异步触发的，晚于下面 watch 里 nextTick 后的手动定位，会把光标又抢回文档
           末尾。只有默认进编辑态（没有具体点击目标）才用它自己的 autofocus。
           @pointerdown.stop：画布贴纸场景下这张卡的根节点是可拖拽的（见 NoteSticker.vue），
           在编辑器里点字/选字/点工具栏不该被外层拖拽阈值判定拦截——列表页没有拖拽，加这个
           不影响原有行为。 -->
      <NoteEditor ref="bodyEditorRef" v-model="draftBody" :autofocus="pendingFocus === null"
                  :float-toolbar="canvasMode" :edit-ready="editReady"
                  @submit="finishEditing" @pointerdown.stop>
        <template #foot-actions>
          <span v-if="conflict" class="nc-conflict">改动冲突，已刷新</span>
          <button class="nc-done-btn" @pointerdown.stop @click.stop="finishEditing" title="完成编辑">
            <PhCheck :size="12" weight="bold" /> 完成
          </button>
        </template>
      </NoteEditor>
    </template>

    <!-- 只读态：真标题（# 打头）才单独摘出来放头部；纯正文/待办/列表整段就是正文，
         不凭空造一条"标题"，编辑/删除按钮改浮在卡右上角。hover 出编辑/删除 -->
    <template v-else>
      <div v-if="isHeading" class="nc-head">
        <span class="nc-title" @click="startEditAt('title')">{{ title }}</span>
        <CardAffordances :hovering="isHovering && !editing" actions-placement="inline" :node-id="null">
          <template #actions>
          <ColorSwatches :model-value="note.color" :allow-none="!canvasMode" @update:model-value="c => emit('color', c)" />
          <button class="nc-icon" title="编辑" @pointerdown.stop @click.stop="startEditAt(null)">
            <PhPencilSimple :size="12" weight="bold" />
          </button>
          <button class="nc-icon danger" title="删除" @pointerdown.stop @click.stop="emit('delete')">
            <PhTrash :size="12" weight="bold" />
          </button>
          </template>
        </CardAffordances>
      </div>
      <CardAffordances v-else :hovering="isHovering && !editing" actions-placement="float" :node-id="null">
        <template #actions>
        <ColorSwatches :model-value="note.color" :allow-none="!canvasMode" @update:model-value="c => emit('color', c)" />
        <button class="nc-icon" title="编辑" @pointerdown.stop @click.stop="startEditAt(null)">
          <PhPencilSimple :size="12" weight="bold" />
        </button>
        <button class="nc-icon danger" title="删除" @pointerdown.stop @click.stop="emit('delete')">
          <PhTrash :size="12" weight="bold" />
        </button>
        </template>
      </CardAffordances>
      <div v-if="bodyMd" ref="bodyRef" class="nc-body md-preview" :class="{ clamped: clamped && !expanded }"
           @click="onBodyClick" v-html="previewHtml"></div>
      <button v-if="clamped" class="nc-expand" @pointerdown.stop @click.stop="expanded = !expanded">
        {{ expanded ? '收起' : '展开' }}
      </button>
    </template>
    <!-- 连接点只有画布模式才有，并且保持在 NoteCard 自己的 DOM 子树里，确保拖拽克隆时
         子树里，不是 NoteSticker.vue 那层壳的兄弟节点）是关键——拖拽克隆 cloneNode(true)
         只拷贝这张卡自己的 DOM 子树，连接点得是这棵子树的真子集，才能跟着克隆体一起飞、
         跟文件/活动/项目引用卡三种画布卡片同样的路数（见 NoteSticker.vue 的说明）。 -->
    <CardAffordances
      v-if="canvasMode"
      :node-id="note.id" :hovering="isHovering && !editing" :connecting="connecting ?? false" :target-side="connectionTargetSide ?? null"
      @connect-drag-start="(e, side) => emit('connect-drag-start', e, side)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhCheck, PhPencilSimple, PhTrash } from '@phosphor-icons/vue'
import { combineTitleBody, mdToPreviewHtml } from '@/composables/useMindEditor'
import { useMindRefActions } from '@/composables/useMindRefActions'
import type { MindNote } from '@/services/api'
import CardAffordances from '@/components/common/CardAffordances.vue'
import ColorSwatches from './ColorSwatches.vue'
import NoteEditor from './NoteEditor.vue'

// Markdown 预览会在时间轴卡片、画布卡片之间复用相同正文。按正文缓存有限数量的 HTML，避免
// 实时刷新或卡片重新挂载时重复做代码高亮；限制容量避免长期编辑造成无界内存增长。
const PREVIEW_CACHE_LIMIT = 256
const previewCache = new Map<string, string>()
function cachedPreviewHtml(md: string): string {
  const cached = previewCache.get(md)
  if (cached !== undefined) return cached
  const html = mdToPreviewHtml(md)
  previewCache.set(md, html)
  if (previewCache.size > PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next().value
    if (oldest !== undefined) previewCache.delete(oldest)
  }
  return html
}

const { openMindRef, resolveMindRef } = useMindRefActions()

const props = defineProps<{
  note: MindNote
  editing: boolean
  highlight: boolean
  conflict: boolean
  // 画布便签（NoteSticker.vue）用这个把材质换回纸感——不透明的纸色/纯色淡染，跟笔记页
  // 时间流里半透明的玻璃质感（.note-card 默认背景）刻意区分开：无限画布上贴纸叠贴纸的
  // 场合，半透明会互相透出底下别的贴纸内容，看着很乱；便签本来就该是"不透明的实体小卡片"
  // （NoteSticker.vue 原来的说法）。不传按笔记页时间流的玻璃质感走，不影响原有页面。
  canvasMode?: boolean
  // 画布相机当前缩放（MindCanvas.vue 的 camera.scale）——spawnToolbarGhost 需要它把
  // getBoundingClientRect 量出的屏幕像素差值换回世界坐标像素，见该函数内的换算注释。
  // 笔记页时间流没有缩放祖先，不传按 1 处理，换算是 no-op。
  scale?: number
  // 建立关联相关——只有画布模式会用（笔记页时间流不支持连线），见下面 CardAffordances 的
  // v-if="canvasMode"。NoteSticker.vue 原样转发 MindCanvas.vue 给它的同名 prop。
  connecting?: boolean
  connectionTargetSide?: 'left' | 'right' | null
}>()

const emit = defineEmits<{
  (e: 'edit'): void
  (e: 'close'): void
  (e: 'save', md: string): void
  (e: 'delete'): void
  (e: 'color', color: string | null): void
  (e: 'toggle-task', idx: number): void
  (e: 'connect-drag-start', event: PointerEvent, side: 'left' | 'right'): void
}>()

// CardAffordances 用 prop 驱动外观（不是 CSS :hover）——只有画布模式才传入 node-id，
// 便签页时间流因此不会渲染连接点。
const isHovering = ref(false)

// 编辑态按区域拆成标题草稿 + 正文草稿（对齐只读态的 nc-head/nc-body 分区），
// 存的时候再拼回 `# 标题\n正文` 这套跟只读态解析约定一致的单串 markdown。
const draftTitle   = ref('')
const draftBody    = ref('')
// 退出编辑时，store 的异步回写还没来得及更新 props.note。预览若立刻读旧正文，卡片高度会
// 先按旧内容收起、等回写后再突然变一次。暂存刚退出时的草稿，让预览和目标高度在同一帧就以
// 新内容计算；外部回写（或冲突后的刷新）抵达后再交还给 props.note。
const pendingPreviewMd = ref<string | null>(null)
const displayContentMd = computed(() => pendingPreviewMd.value ?? props.note.contentMd ?? '')
const expanded     = ref(false)
const clamped      = ref(false)
const bodyRef      = ref<HTMLElement | null>(null)
const cardRef      = ref<HTMLElement | null>(null)
const bodyEditorRef = ref<InstanceType<typeof NoteEditor> | null>(null)
// 编辑器初始光标落点是异步的（不管默认 autofocus:'end' 还是我们手动定位），刚挂载那一瞬间
// 可能先落在文档默认位置（比如正文开头是待办，就会先亮一下待办的样式）再跳到正确位置。
// 定位真正落定前先把整张卡藏起来（保留布局占位，不闪跳），避免这个过渡态被看见。
const editReady = ref(false)
// 编辑/预览切换的展开收回动画：v-if 直接换整块内容，高度没法从/到 auto 做过渡（CSS 不
// 支持），所以手动量出切换前后两个真实高度，冻结成具体 px 值再过渡，动画播完再放回 auto——
// 不然预览态里后续「展开/收起」长内容、编辑态里继续打字撑高，都会被钉死在这个旧的 px 值上。
const cardHeight = ref<string>('auto')
const HEIGHT_ANIM_MS = 190   // 跟下面 .note-card 的 height 过渡时长保持一致
// 退出编辑态时工具栏的模糊淡出：真实工具栏马上要被 v-if 摘掉，自己没法播 transition，
// 所以摘之前先克隆一份浮在原地继续淡出，跟下面的收起动画同时开始（见 spawnToolbarGhost）。
const TOOLBAR_FADE_MS = 110
const titleInputRef = ref<HTMLInputElement | null>(null)
// 点哪进编辑态光标就落在哪：'title' 落标题框，数字落正文对应行（跟 mdToPreviewHtml 的
// data-line-unit 对应），null 就随 NoteEditor 自己的 autofocus:'end'（默认落文档末尾）。
const pendingFocus = ref<'title' | number | null>(null)
function startEditAt(target: 'title' | number | null) {
  pendingFocus.value = target
  emit('edit')
}

function serializeDraft(): string {
  return combineTitleBody(draftTitle.value, draftBody.value)
}

/** 自动保存：停顿 AUTOSAVE_MS 没再改就存一次；不再有手动「保存」这个动作。 */
const AUTOSAVE_MS = 900
let saveTimer: ReturnType<typeof setTimeout> | null = null
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const md = serializeDraft()
  if (md !== props.note.contentMd) emit('save', md)
}
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, AUTOSAVE_MS)
}
watch([draftTitle, draftBody], () => { if (props.editing) scheduleSave() })
watch(() => props.note.contentMd, () => {
  if (!props.editing) pendingPreviewMd.value = null
})

/** 点卡片外面：先补一次保存，再退出编辑态（不再是「取消」，没有可丢弃的东西）。
 *  NoteEditor 的「样式」「插入」抽屉是原地展开、卡片的真实 DOM 后代，点里面的按钮天然
 *  会被 cardRef.contains() 认成"没点外面"，不用再单独放行。
 *  `@` 引用补全下拉和画布便签的浮动工具栏（floatToolbar，见 NoteEditor.vue）都是例外——
 *  两者都 Teleport 到了 body（前者躲避卡片 overflow:hidden 的裁切，后者躲避画布便签
 *  太窄装不下横排图标），点它们天然不在 cardRef 内，得单独放行，不然点下拉选项/工具栏
 *  按钮那一刻会先被这里判成"点外面"触发 finishEditing/editor 卸载，choose() 或工具栏的
 *  点击处理再执行时 editor.value 已经是 null（`@` 下拉那边踩过：TypeError: Cannot read
 *  properties of null (reading 'chain')）。 */
function onDocDown(e: MouseEvent) {
  if (!props.editing) return
  const t = e.target as HTMLElement
  if (cardRef.value?.contains(t) || t.closest('.ne-picker') || t.closest('.ne-toolbar-floating')) return
  finishEditing()
}
// finishEditing 已经同步 flush 过一次；emit('close') 会让 editing 变 false 反过来触发下面
// 那个 watch，此时保存请求可能还没落地、props.note.contentMd 还是旧值，若 watch 再 flush
// 一次会拿同一份 draft、同一个旧 version 再发一次 PATCH——自己把自己撞出 409。这个标记
// 就是防止同一次关闭被 flush 两遍。
let closedByFinish = false
function finishEditing() {
  closedByFinish = true
  flushSave()
  emit('close')
}

/** 工具栏收起淡出：真实 .ne-toolbar 马上要被 v-if 摘掉，没法自己播 transition——摘之前
 *  克隆一份、定位在原处叠一层继续做模糊淡出，跟卡片的收起动画同时开始（都是 editing 变
 *  false 那一刻触发，互不等待），播完自己从 DOM 里清掉。卡片本身还在同步缩小，克隆节点
 *  的定位是固定像素值，缩到比它矮时会被 .note-card 的 overflow:hidden 提前裁掉一截，
 *  这是几何上跑不掉的（收起动画目标高度本来就比编辑态矮），可以接受。
 *  ⚠️ 两种工具栏要接两套完全不同的坐标系，不能共用一份定位公式：
 *  - 非浮动（列表/时间流）：真实 .ne-toolbar 本来就是卡片的 DOM 后代，活在 cardEl 的
 *    局部坐标系下；画布场景里 cardEl 自己还套着 .canvas-world 的 transform:
 *    scale(camera.scale) 祖先。ghost 挂回 cardEl 内部延续同一套局部坐标，但
 *    getBoundingClientRect 量出来的 cardRect/toolbarRect 已经是缩放后的屏幕坐标，
 *    直接拿屏幕差值原样赋给 ghost 的 CSS 会被这层祖先缩放二次叠加，除以 scale 换回
 *    局部单位才能让 ghost 准确贴在原位置（缩放 100% 之外会飘走）。
 *  - 浮动（画布便签，floatToolbar）：真实工具栏 Teleport 到了 body，活在 .canvas-world
 *    缩放祖先之外——不管画布怎么缩放，它的图标/文字都是恒定的屏幕像素大小，只有位置
 *    跟着卡片走（见 NoteEditor.vue 的 updateFloatToolbarPos）。ghost 要延续同一套"屏幕
 *    像素、不随画布缩放"的坐标系，因此也要挂在 body 上、直接用 toolbarRect 的屏幕坐标，
 *    不能套用非浮动那份除以 scale 的公式——那是给"活在缩放祖先里的元素"补偿用的，套在
 *    一个根本不在缩放祖先里的元素上会把缩放系数二次带进来，画布缩放不是 100% 时
 *    ghost 的视觉大小就会跟着莫名其妙放大/缩小（局部宽度被除以/乘以 scale 撑大或压小，
 *    子元素图标却还是原始像素尺寸不跟着变，两者对不上；这份局部宽度又要再经过缩放祖先
 *    的 transform 二次缩放一遍，误差就是这么来的）。 */
function spawnToolbarGhost() {
  const cardEl = cardRef.value
  const toolbarEl = bodyEditorRef.value?.getToolbarEl() ?? cardEl?.querySelector<HTMLElement>('.ne-toolbar')
  if (!cardEl || !toolbarEl) return
  const floating = !cardEl.contains(toolbarEl)
  const toolbarRect = toolbarEl.getBoundingClientRect()
  const ghost = toolbarEl.cloneNode(true) as HTMLElement
  ghost.style.margin = '0'
  ghost.style.pointerEvents = 'none'
  ghost.style.opacity = '1'
  ghost.style.filter = 'blur(0)'
  ghost.style.transition = `opacity ${TOOLBAR_FADE_MS}ms ease-in-out, filter ${TOOLBAR_FADE_MS}ms ease-in-out`
  if (floating) {
    ghost.style.position = 'fixed'
    ghost.style.zIndex = '2000'
    ghost.style.left = `${toolbarRect.left}px`
    ghost.style.top = `${toolbarRect.top}px`
    ghost.style.transform = 'none'
    document.body.appendChild(ghost)
  } else {
    const scale = props.scale || 1
    const cardRect = cardEl.getBoundingClientRect()
    ghost.style.position = 'absolute'
    ghost.style.zIndex = '2'
    ghost.style.left = `${(toolbarRect.left - cardRect.left) / scale}px`
    ghost.style.top = `${(toolbarRect.top - cardRect.top) / scale}px`
    ghost.style.width = `${toolbarRect.width / scale}px`
    cardEl.appendChild(ghost)
  }
  requestAnimationFrame(() => {
    ghost.style.opacity = '0'
    ghost.style.filter = 'blur(6px)'
  })
  setTimeout(() => ghost.remove(), TOOLBAR_FADE_MS + 20)
}

let heightResetTimer: ReturnType<typeof setTimeout> | null = null
watch(() => props.editing, async (v, prev) => {
  if (heightResetTimer) { clearTimeout(heightResetTimer); heightResetTimer = null }
  const el = cardRef.value
  const startH = el?.offsetHeight ?? null

  if (v) {
    closedByFinish = false
    editReady.value = false
    draftTitle.value = _split.value.titleRaw
    draftBody.value = _split.value.body
    document.addEventListener('mousedown', onDocDown, true)
    await nextTick()
    if (pendingFocus.value === 'title') titleInputRef.value?.focus()
    else if (typeof pendingFocus.value === 'number') bodyEditorRef.value?.focusAtLineUnit(pendingFocus.value)
    pendingFocus.value = null
    editReady.value = true
  } else {
    spawnToolbarGhost()
    document.removeEventListener('mousedown', onDocDown, true)
    if (prev && !closedByFinish) flushSave()
    pendingPreviewMd.value = serializeDraft()
    closedByFinish = false
    editReady.value = false
    await nextTick()
  }

  if (el && startH != null) {
    cardHeight.value = 'auto'
    await nextTick()
    const endH = el.offsetHeight
    cardHeight.value = startH + 'px'
    await nextTick()
    void el.offsetHeight
    requestAnimationFrame(() => {
      cardHeight.value = endH + 'px'
      heightResetTimer = setTimeout(() => { cardHeight.value = 'auto'; heightResetTimer = null }, HEIGHT_ANIM_MS)
    })
  } else {
    cardHeight.value = 'auto'
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  if (heightResetTimer) clearTimeout(heightResetTimer)
})

const _split = computed(() => {
  const md = displayContentMd.value
  const lines = md.split('\n')
  const ti = lines.findIndex(l => l.trim())
  if (ti < 0) return { title: '（空笔记）', titleRaw: '', body: '', isHeading: true }
  const titleLine = lines[ti].trim()
  const isHeading = /^#{1,6}\s+/.test(titleLine)
  if (!isHeading) return { title: '', titleRaw: '', body: md, isHeading: false }
  const raw = titleLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/\[\[[a-z_]+:\d+\|([^\]]*)\]\]/g, '$1')
  const body = lines.slice(ti + 1).join('\n').replace(/^\n+/, '')
  return { title: raw || '（无标题）', titleRaw: raw, body, isHeading: true }
})
const title     = computed(() => _split.value.title)
const isHeading = computed(() => _split.value.isHeading)
const bodyMd = computed(() => _split.value.body)
const previewHtml = computed(() => bodyMd.value ? cachedPreviewHtml(bodyMd.value) : '')

async function measureClamp() {
  await nextTick()
  const el = bodyRef.value
  if (!el) return
  if (expanded.value) return
  clamped.value = el.scrollHeight > el.clientHeight + 2
}
async function refreshReferenceStates() {
  await nextTick()
  const refs = bodyRef.value?.querySelectorAll<HTMLElement>('.mind-ref[data-ref-type][data-ref-id]') ?? []
  await Promise.all([...refs].map(async refEl => {
    const state = await resolveMindRef(refEl.dataset.refType!, Number(refEl.dataset.refId))
    refEl.classList.toggle('mind-ref-missing', state === 'missing')
    if (state === 'missing') refEl.title = '关联对象已删除，仅保留快照'
  }))
}
onMounted(() => { measureClamp(); refreshReferenceStates() })
watch(() => props.note.contentMd, () => { expanded.value = false; measureClamp(); refreshReferenceStates() })

function onBodyClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t instanceof HTMLInputElement && t.dataset.taskIdx !== undefined) {
    e.preventDefault()
    emit('toggle-task', Number(t.dataset.taskIdx))
    return
  }
  const refEl = t.closest<HTMLElement>('.mind-ref')
  if (refEl) {
    if (refEl.classList.contains('mind-ref-missing')) return
    const refType = refEl.dataset.refType
    const refId = Number(refEl.dataset.refId)
    if (refType && Number.isFinite(refId)) openMindRef(refType, refId)
    return
  }
  if (t.closest('a')) return
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.toString().length > 0) return
  const lineEl = t.closest<HTMLElement>('[data-line-unit]')
  startEditAt(lineEl ? Number(lineEl.dataset.lineUnit) : null)
}

defineExpose({ rootEl: cardRef })
</script>

<style scoped>
.note-card {
  position: relative;
  padding: 11px 13px;
  min-height: 140px;
  box-sizing: border-box;
  border-radius: 14px;
  corner-shape: round;
  background: rgba(255,255,255,0.56);
  border: 1px solid rgba(255,255,255,0.72);
  box-shadow: 0 2px 8px rgba(80,90,110,0.07);
  min-width: 0;
  overflow: hidden;
  transition: transform 0.25s cubic-bezier(0.34,1.2,0.64,1),
              box-shadow 0.3s ease, background 0.25s ease-out, height 0.19s cubic-bezier(0.65,0,0.35,1);
}
.note-card::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(to top, rgba(255,255,255,0.08), transparent 50%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  transition: background 0.3s cubic-bezier(0.34,1.2,0.64,1);
  pointer-events: none;
}
.note-card > * { position: relative; z-index: 1; }
.note-card:not(.editing):hover { box-shadow: 0 6px 18px rgba(80,90,110,0.13); }
.note-card:not(.editing):hover::after { background: rgba(255,255,255,0.2); }

/* 画布连接态的外围虚线统一由 CardAffordances 拥有；NoteCard 的 ::after 只负责纸面高光。 */
.note-card.editing { background: rgba(255,255,255,0.9); }
.note-card.nc-edit-pending { opacity: 0; pointer-events: none; }
.note-card.editing { display: flex; flex-direction: column; }
.note-card.editing :deep(.note-editor) { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.note-card.editing :deep(.ne-toolbar) {
  opacity: 0;
  filter: blur(6px);
  transition: opacity 0.14s ease-in-out, filter 0.14s ease-in-out;
}
.note-card.editing:not(.nc-edit-pending) :deep(.ne-toolbar) { opacity: 1; filter: blur(0); }
.note-card.editing :deep(.ne-body) { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.note-card.editing :deep(.ne-body .ProseMirror) { flex: 1; min-height: 0; }
.nc-title-input {
  flex-shrink: 0;
  width: 100%;
  border: none;
  outline: none;
  background: none;
  padding: 0 0 7px;
  margin-bottom: 4px;
  border-bottom: 1px solid rgba(80,90,110,0.1);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--text-primary);
  font-family: var(--font-sans);
}
.nc-title-input::placeholder { color: var(--text-secondary); opacity: 0.5; font-weight: 400; }
.note-card.highlight { animation: nc-flash 1.6s ease-out; }
@keyframes nc-flash {
  0% { background-color: rgba(123,127,178,0.2); }
  100% { background-color: rgba(255,255,255,0.56); }
}
.note-card.tint-amber { background: rgb(255,246,231); }
.note-card.tint-coral { background: rgb(255,236,233); }
.note-card.tint-blue  { background: rgb(224,239,251); }
.note-card.tint-teal  { background: rgb(229,248,250); }
.note-card.canvas-mode { background: rgba(255,252,238,0.97); }
.note-card.canvas-mode.tint-amber { background: rgb(255,246,231); }
.note-card.canvas-mode.tint-coral { background: rgb(255,236,233); }
.note-card.canvas-mode.tint-blue  { background: rgb(224,239,251); }
.note-card.canvas-mode.tint-teal  { background: rgb(229,248,250); }
.note-card.canvas-mode { overflow: visible; }

.nc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  position: relative;
  z-index: 1;
}
.nc-head:has(+ .nc-body) {
  padding-bottom: 7px;
  border-bottom: 1px solid rgba(80,90,110,0.1);
}
.nc-title {
  flex: 1;
  min-width: 0;
  cursor: text;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nc-icon {
  padding: 3px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.nc-icon:hover { background: rgba(123,127,178,0.12); color: var(--color-primary); }
.nc-icon.danger:hover { background: rgba(176,120,88,0.12); color: #b07858; }
.nc-body {
  position: relative;
  z-index: 1;
  cursor: text;
  min-height: 76px;
  overflow-wrap: anywhere;
}
.nc-body.clamped {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
  overflow: hidden;
}
.nc-expand {
  margin-top: 4px;
  padding: 0;
  border: none;
  background: none;
  font-size: 11px;
  color: var(--color-primary);
  cursor: pointer;
  font-family: var(--font-sans);
  position: relative;
  z-index: 1;
}
.nc-conflict { font-size: 11px; color: #b07858; white-space: nowrap; }
.nc-done-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: none;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-primary);
  cursor: pointer;
  font-family: var(--font-sans);
  white-space: nowrap;
  transition: background 0.12s;
}
.nc-done-btn:hover { background: rgba(123,127,178,0.12); }
</style>

<style src="./mind-content.css"></style>
