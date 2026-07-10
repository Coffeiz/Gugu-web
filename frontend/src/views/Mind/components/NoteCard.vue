<template>
  <div ref="cardRef" class="note-card"
       :class="{ editing, highlight, 'nc-edit-pending': editing && !editReady, ['tint-' + (note.color || '')]: !!note.color }">
    <!-- 编辑态：跟只读态一样按区域分标题区/正文区（不是靠"标题"文字样式段落类型），
         就地展开（跨两列由父级 grid-column 控制）；自动保存，没有取消/保存按钮——
         停顿一下自己存，点卡外面就算编完（先补一次保存再退出）。 -->
    <template v-if="editing">
      <input
        ref="titleInputRef"
        v-model="draftTitle" class="nc-title-input" placeholder="标题（可选）"
        @keydown.enter.prevent="bodyEditorRef?.focus()"
      />
      <!-- pendingFocus 有具体目标（标题/某一行）时不让编辑器自己 autofocus:'end'——它内部的
           自动聚焦是异步触发的，晚于下面 watch 里 nextTick 后的手动定位，会把光标又抢回文档
           末尾。只有默认进编辑态（没有具体点击目标）才用它自己的 autofocus。 -->
      <NoteEditor ref="bodyEditorRef" v-model="draftBody" :autofocus="pendingFocus === null" @submit="finishEditing">
        <template v-if="conflict" #foot-actions>
          <span class="nc-conflict">改动冲突，已刷新</span>
        </template>
      </NoteEditor>
    </template>

    <!-- 只读态：真标题（# 打头）才单独摘出来放头部；纯正文/待办/列表整段就是正文，
         不凭空造一条"标题"，编辑/删除按钮改浮在卡右上角。hover 出编辑/删除 -->
    <template v-else>
      <div v-if="isHeading" class="nc-head">
        <span class="nc-title" @click="startEditAt('title')">{{ title }}</span>
        <span class="nc-actions">
          <button class="nc-icon" title="编辑" @click.stop="startEditAt(null)">
            <PhPencilSimple :size="12" weight="bold" />
          </button>
          <button class="nc-icon danger" title="删除" @click.stop="emit('delete')">
            <PhTrash :size="12" weight="bold" />
          </button>
        </span>
      </div>
      <span v-else class="nc-actions nc-actions-float">
        <button class="nc-icon" title="编辑" @click.stop="startEditAt(null)">
          <PhPencilSimple :size="12" weight="bold" />
        </button>
        <button class="nc-icon danger" title="删除" @click.stop="emit('delete')">
          <PhTrash :size="12" weight="bold" />
        </button>
      </span>
      <div v-if="bodyMd" ref="bodyRef" class="nc-body md-preview" :class="{ clamped: clamped && !expanded }"
           @click="onBodyClick" v-html="mdToPreviewHtml(bodyMd)"></div>
      <button v-if="clamped" class="nc-expand" @click.stop="expanded = !expanded">
        {{ expanded ? '收起' : '展开' }}
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhPencilSimple, PhTrash } from '@phosphor-icons/vue'
import { combineTitleBody, mdToPreviewHtml } from '@/composables/useMindEditor'
import type { MindNote } from '@/services/api'
import NoteEditor from './NoteEditor.vue'

const props = defineProps<{
  note: MindNote
  editing: boolean
  highlight: boolean
  conflict: boolean
}>()

const emit = defineEmits<{
  (e: 'edit'): void
  (e: 'close'): void
  (e: 'save', md: string): void
  (e: 'delete'): void
  (e: 'toggle-task', idx: number): void
}>()

// 编辑态按区域拆成标题草稿 + 正文草稿（对齐只读态的 nc-head/nc-body 分区），
// 存的时候再拼回 `# 标题\n正文` 这套跟只读态解析约定一致的单串 markdown。
const draftTitle   = ref('')
const draftBody    = ref('')
const expanded     = ref(false)
const clamped      = ref(false)
const bodyRef      = ref<HTMLElement | null>(null)
const cardRef      = ref<HTMLElement | null>(null)
const bodyEditorRef = ref<InstanceType<typeof NoteEditor> | null>(null)
// 编辑器初始光标落点是异步的（不管默认 autofocus:'end' 还是我们手动定位），刚挂载那一瞬间
// 可能先落在文档默认位置（比如正文开头是待办，就会先亮一下待办的样式）再跳到正确位置。
// 定位真正落定前先把整张卡藏起来（保留布局占位，不闪跳），避免这个过渡态被看见。
const editReady = ref(false)
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

/** 点卡片外面：先补一次保存，再退出编辑态（不再是「取消」，没有可丢弃的东西）。
 *  NoteEditor 的「样式」二级菜单 Teleport 到 body，不再是卡片的 DOM 后代，得单独放行——
 *  同 CaptureBar.vue 对 DatePicker 的 .dp-popup 那套，点菜单里的按钮不算"点外面"。 */
function onDocDown(e: MouseEvent) {
  if (!props.editing) return
  const t = e.target as HTMLElement
  if (cardRef.value?.contains(t)) return
  if (t.closest?.('.ne-style-menu')) return
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

// 进入编辑时灌当前内容为草稿；退出时（点外面/切换到别的便签走 finishEditing 之外的路径，
// 比如便签被删除强制退出编辑）才需要这里兜底补一次保存。编辑期间才挂全局点击监听，
// 避免每张卡常驻一个 document 监听器。
watch(() => props.editing, async (v, prev) => {
  if (v) {
    closedByFinish = false
    editReady.value = false
    draftTitle.value = _split.value.titleRaw
    draftBody.value = _split.value.body
    document.addEventListener('mousedown', onDocDown, true)
    await nextTick()   // 等 NoteEditor 挂载、自己的 autofocus:'end' 先跑完，这里再改写光标位置
    if (pendingFocus.value === 'title') titleInputRef.value?.focus()
    else if (typeof pendingFocus.value === 'number') bodyEditorRef.value?.focusAtLineUnit(pendingFocus.value)
    pendingFocus.value = null
    editReady.value = true   // 光标真正落定了，这时候才让卡片显形
  } else {
    document.removeEventListener('mousedown', onDocDown, true)
    if (prev && !closedByFinish) flushSave()
    closedByFinish = false
    editReady.value = false
  }
})
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocDown, true))

/** 标题只在首行真是 `#` 标题格式时才从正文摘出来单独展示；纯正文/待办/列表开头的便签
 *  不摘任何东西——整段原样进 body 渲染，不会凭空多出一条"标题"把第一行跟其余内容分割开。
 *  titleRaw 是没套占位文案的原始值，给编辑态的标题草稿做种（title 那个"（空便签）"/
 *  "（无标题）"是只读态才该出现的占位显示，塞进输入框会变成假装用户写了这几个字）。 */
const _split = computed(() => {
  const md = props.note.contentMd || ''
  const lines = md.split('\n')
  const ti = lines.findIndex(l => l.trim())
  if (ti < 0) return { title: '（空便签）', titleRaw: '', body: '', isHeading: true }
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

/** 是否溢出 clamp 高度（内容/展开态变了都重测）。scrollHeight 对比要在未展开的 clamp 态量 */
async function measureClamp() {
  await nextTick()
  const el = bodyRef.value
  if (!el) return
  if (expanded.value) return   // 展开着就保持"可收起"，不重判
  clamped.value = el.scrollHeight > el.clientHeight + 2
}
onMounted(measureClamp)
watch(() => props.note.contentMd, () => { expanded.value = false; measureClamp() })

/** 卡上直接勾待办：点击落在预览里的 checkbox 时翻转对应任务，不进编辑态 */
function onBodyClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t instanceof HTMLInputElement && t.dataset.taskIdx !== undefined) {
    e.preventDefault()   // 视觉状态由 PATCH 成功后的数据回流驱动，别让浏览器先勾上
    // 标题只会摘掉真正的 # 标题行，待办/列表都不会被摘，body 里的序号就是完整 content 里的真实序号
    emit('toggle-task', Number(t.dataset.taskIdx))
    return
  }
  // 点引用 chip 不进编辑（将来跳对应对象页）；点链接就正常跳转，也不进编辑；
  // 点其他区域进编辑，光标定到点的那一行后面
  if (t.closest('.mind-ref')) return
  if (t.closest('a')) return
  const lineEl = t.closest<HTMLElement>('[data-line-unit]')
  startEditAt(lineEl ? Number(lineEl.dataset.lineUnit) : null)
}
</script>

<style scoped>
/* 便签卡：与定时任务卡/项目卡同款质感（白 56% 底 + 白描边 + 顶部高光 ::after + hover
   加深阴影），躺在每日玻璃底板之内。卡自身不用 backdrop-filter（底板已经是玻璃），
   卡内 hover/让位动画都发生在底板内容层，不碰底板的 backdrop。 */
.note-card {
  position: relative;
  padding: 11px 13px;
  min-height: 140px;   /* 卡片本身兜住方形高度，不依赖 .nc-body 是否渲染（纯标题便签也不会变扁） */
  box-sizing: border-box;
  border-radius: var(--radius-md);
  background: rgba(255,255,255,0.56);
  border: 1px solid rgba(255,255,255,0.72);
  box-shadow: 0 2px 8px rgba(80,90,110,0.07);
  min-width: 0; overflow: hidden;
  transition: box-shadow 0.3s ease, background 0.25s ease-out;
}
/* 顶部高光层（task-card 同款）：hover 时整层提亮 */
.note-card::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: linear-gradient(to top, rgba(255,255,255,0.08), transparent 50%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  transition: background 0.3s cubic-bezier(0.34,1.2,0.64,1); pointer-events: none;
}
.note-card > * { position: relative; z-index: 1; }
.note-card:not(.editing):hover { box-shadow: 0 6px 18px rgba(80,90,110,0.13); }
.note-card:not(.editing):hover::after { background: rgba(255,255,255,0.2); }

.note-card.editing { background: rgba(255,255,255,0.9); }
/* 光标还没定位到该去的地方之前（默认落点/上一次残留选区）先藏起来，不让这个过渡态被看见——
   比如正文开头是待办，进编辑态那一瞬容易先"亮"一下待办的默认焦点样式再跳到该定的位置。
   用 opacity 不用 visibility：visibility:hidden 的元素浏览器不让 focus()，我们恰恰要在
   这段隐藏期间调用 focus()/focusAtLineUnit() 把光标定过去，用 visibility 会导致这次
   focus() 直接是空操作，编辑器永远拿不到真正的焦点（工具栏 isFocused 判断就一直是 false）。
   opacity:0 不影响可聚焦性，配 pointer-events:none 防这段时间被点到。布局占位保留，
   不会引起列内卡片抖动。 */
.note-card.nc-edit-pending { opacity: 0; pointer-events: none; }
/* 窄列里就地编辑：工具栏放不下「输入 @ 引用…」提示文字，藏掉（捕捉条那份还在） */
.note-card.editing :deep(.ne-hint) { display: none; }
/* 编辑态整卡走 flex 列：编辑器吃满剩余高度，取消/保存永远贴在卡片底部，不会因为内容
   短、卡片够着 min-height 的地板价时，按钮悬在半截、下面空一大截。 */
.note-card.editing {
  display: flex; flex-direction: column;
}
.note-card.editing :deep(.note-editor) {
  flex: 1; display: flex; flex-direction: column; min-height: 0;
}
.note-card.editing :deep(.ne-body) {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
}
.note-card.editing :deep(.ne-body .ProseMirror) {
  flex: 1; min-height: 0;
}
/* 编辑态标题区：跟只读态 .nc-title 同样字号字重，固定分割线跟正文区隔开（不管有没有
   打字都分——按区域区分，不是靠有没有内容判断）。 */
.nc-title-input {
  flex-shrink: 0; width: 100%;
  border: none; outline: none; background: none; padding: 0 0 7px; margin-bottom: 4px;
  border-bottom: 1px solid rgba(80,90,110,0.1);
  font-size: 14px; font-weight: 600; line-height: 1.35;
  color: var(--text-primary); font-family: var(--font-sans);
}
.nc-title-input::placeholder { color: var(--text-secondary); opacity: 0.5; font-weight: 400; }

/* 新建高亮：紫灰 tint 淡出（提交滚回最左后让新卡自己说"我在这") */
.note-card.highlight { animation: nc-flash 1.6s ease-out; }
@keyframes nc-flash {
  0% { background-color: rgba(123,127,178,0.2); }
  100% { background-color: rgba(255,255,255,0.56); }
}

/* 可选低饱和颜色：整卡淡染（便签纸语言），不做左侧色条（那是管理系统语言） */
.note-card.tint-purple { background: rgba(123,127,178,0.14); }
.note-card.tint-pink   { background: rgba(196,175,200,0.18); }
.note-card.tint-cyan   { background: rgba(122,184,200,0.15); }
.note-card.tint-amber  { background: rgba(212,178,112,0.16); }

.nc-head {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 4px; position: relative; z-index: 1;
}
/* 只有正文存在时才分割——纯标题便签不该悬空挂一条线 */
.nc-head:has(+ .nc-body) {
  padding-bottom: 7px;
  border-bottom: 1px solid rgba(80,90,110,0.1);
}
/* 单行截断而不是 2 行 clamp：编辑态的标题是单行 <input>（不会换行），只读态如果允许标题
   换行到 2 行，同一条标题在两种状态下占的高度不一样，分割线的位置就会跟着挪——标题
   本来就该短，单行更符合预期，也让编辑/只读两态的几何完全对齐。 */
.nc-title {
  flex: 1; min-width: 0; cursor: text;
  font-size: 14px; font-weight: 600; line-height: 1.35; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.nc-actions { margin-left: auto; flex-shrink: 0; display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
.note-card:hover .nc-actions { opacity: 1; }
/* 没有真标题的卡：编辑/删除浮在右上角，不占正文的地方、不凭空造一条头部 */
.nc-actions-float {
  position: absolute; top: 11px; right: 13px; z-index: 2;
  margin-left: 0;
}
.nc-icon {
  padding: 3px; border: none; border-radius: 5px;
  background: transparent; color: var(--text-secondary); cursor: pointer;
  display: inline-flex; align-items: center;
}
.nc-icon:hover { background: rgba(123,127,178,0.12); color: var(--color-primary); }
.nc-icon.danger:hover { background: rgba(176,120,88,0.12); color: #b07858; }

/* min-height 让短便签也有几行留白、卡片偏方形——一行字的扁条卡在 400px 列里太寒酸；
   overflow-wrap 治连续长串（纯数字/URL）不换行撑破卡片 */
.nc-body {
  position: relative; z-index: 1; cursor: text;
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
  margin-top: 4px; padding: 0; border: none; background: none;
  font-size: 11px; color: var(--color-primary); cursor: pointer;
  font-family: var(--font-sans); position: relative; z-index: 1;
}

.nc-conflict { font-size: 11px; color: #b07858; white-space: nowrap; }
</style>

<!-- v-html 出来的预览内容不能 scoped；排版规则跟 NoteEditor.vue 共用同一份文件，
     两边数值必须一致，见 mind-content.css 顶部注释 -->
<style src="./mind-content.css"></style>
