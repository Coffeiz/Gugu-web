/**
 * 思维面板 store（P1：只管「笔记」这一半）。
 *
 * 时间流按 capturedAt 倒序——补录昨天的想法要落回它「发生」的那天，不能因为刚写就排最前，
 * 所以本地插入/改动后一律重排，不假设「新写的就在最前面」。
 *
 * 便签更新走乐观锁：请求带 version，后端版本对不上回 409。这里把 409 单独抛成
 * `MindConflictError`，调用方（编辑器）据此提示「已被其他端修改」并重新拉取。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import {
  mindApi, type MindCanvas, type MindCanvasItem, type MindCanvasNoteCreate, type MindNote, type MindNoteCreate,
  type MindNoteUpdate, type MindRelation,
} from '@/services/api'
import { localDayKey, parseUtc } from '@/utils/dateAttribution'
import type { RelationAnchorSides } from '@/composables/useMindCanvas'
import { useLiveStore } from '@/stores/live'

export class MindConflictError extends Error {
  constructor() { super('便签已被其他端修改') }
}

/** 按 capturedAt 倒序；同一时刻用 id 兜底，保证顺序稳定不抖 */
function byCapturedDesc(a: MindNote, b: MindNote): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1
  return b.id - a.id
}

/** 引用锚点 `[[project:7|某项目]]` 只留显示名，给前端筛选当纯文本用 */
function plainOf(md: string): string {
  return md.replace(/\[\[[a-z_]+:\d+\|([^\]]*)\]\]/g, '$1')
}

let optimisticSeq = 0

export const useMindStore = defineStore('mind', () => {
  const notes   = ref<MindNote[]>([])
  const loading = ref(false)
  const loaded  = ref(false)
  const filterQ = ref('')   // 胶囊条的便签筛选（客户端过滤已加载的便签）
  const jumpTarget = ref('')   // 顶部日历选中的日期：跨 index.vue/NotesView.vue 传递跳转意图
  const canvases = ref<MindCanvas[]>([])
  const canvasesLoaded = ref(false)
  const canvasLoading = ref(false)
  const activeCanvasId = ref<number | null>(null)
  const canvasItems = ref<MindCanvasItem[]>([])
  const canvasRelations = ref<MindRelation[]>([])
  const canvasDataSaves = new Map<number, Promise<void>>()

  /** 时间流：按 capturedAt 分组成「一天一组」，供 NoteTimeline 渲染；筛选词命中正文才留 */
  const timeline = computed(() => {
    const q = filterQ.value.trim().toLowerCase()
    const pool = q
      ? notes.value.filter(n => plainOf(n.contentMd).toLowerCase().includes(q))
      : notes.value
    const groups: { date: string; items: MindNote[] }[] = []
    for (const n of [...pool].sort(byCapturedDesc)) {
      const date = localDayKey(parseUtc(n.capturedAt))   // 按用户本地日分组（不是 UTC 日，否则跨午夜错一天）
      const last = groups[groups.length - 1]
      if (last && last.date === date) last.items.push(n)
      else groups.push({ date, items: [n] })
    }
    return groups
  })

  async function fetchNotes() {
    loading.value = true
    try {
      notes.value = await mindApi.listNotes(200, 0)
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  async function createNote(data: MindNoteCreate): Promise<MindNote> {
    const created = await mindApi.createNote(data)
    notes.value = [created, ...notes.value].sort(byCapturedDesc)
    return created
  }

  async function updateNote(id: number, data: MindNoteUpdate): Promise<MindNote> {
    // 乐观更新：改动先立刻摆进本地列表用于显示，不等网络往返——不然编辑完一关卡片，
    // 只读态会先用回旧内容闪一下、等 PATCH 落地才变新内容，观感上不像"乐观保存"。
    // 特意不碰 version：那是下一次乐观锁请求要带的值，得等服务端真的确认过才能往前挪，
    // 否则两次编辑离得很近时，后一次会拿着"还没被服务端确认过"的 version 去比对，
    // 平白撞出本不该有的 409（对不齐锁版本 ≠ 真的有冲突）。
    const optimisticIdx = notes.value.findIndex(n => n.id === id)
    if (optimisticIdx !== -1) notes.value[optimisticIdx] = { ...notes.value[optimisticIdx], ...data }

    let updated: MindNote
    try {
      updated = await mindApi.updateNote(id, data)
    } catch (e: any) {
      if (e?.status === 409) throw new MindConflictError()
      throw e
    }
    const i = notes.value.findIndex(n => n.id === id)
    if (i !== -1) notes.value[i] = updated
    notes.value = [...notes.value].sort(byCapturedDesc)   // capturedAt 可能被改过
    return updated
  }

  /** 软删：后端只写 deleted_at（墓碑），这里从列表里摘掉即可 */
  async function deleteNote(id: number) {
    await mindApi.deleteNote(id)
    notes.value = notes.value.filter(n => n.id !== id)
  }

  async function fetchCanvases() {
    canvasLoading.value = true
    try {
      canvases.value = await mindApi.listCanvases()
      canvasesLoaded.value = true
    } finally {
      canvasLoading.value = false
    }
  }

  async function createCanvas(title = '未命名画布') {
    const canvas = await mindApi.createCanvas({ title })
    canvases.value = [canvas, ...canvases.value]
    return canvas
  }

  async function renameCanvas(id: number, title: string) {
    const updated = await mindApi.updateCanvas(id, { title })
    const index = canvases.value.findIndex(canvas => canvas.id === id)
    if (index !== -1) canvases.value[index] = updated
    return updated
  }

  async function deleteCanvas(id: number) {
    await mindApi.deleteCanvas(id)
    canvases.value = canvases.value.filter(canvas => canvas.id !== id)
    // 删的正好是当前打开这张——清空本地视图状态，CanvasView.vue 的 ensureCanvas() 会在
    // 路由跳到别的画布 id 后自然重新 loadCanvas；这里不主动切换，留给调用方决定切去哪张
    // （比如优先切到列表里剩下的第一张，没有了就新建一张）。
    if (activeCanvasId.value === id) {
      activeCanvasId.value = null
      canvasItems.value = []
      canvasRelations.value = []
    }
  }

  async function loadCanvas(id: number) {
    activeCanvasId.value = id
    const [items, relations] = await Promise.all([
      mindApi.listCanvasItems(id),
      mindApi.listCanvasRelations(id),
    ])
    if (activeCanvasId.value !== id) return
    canvasItems.value = items
    canvasRelations.value = relations
  }

  async function addNoteToCanvas(canvasId: number, note: MindNote, x: number, y: number) {
    const item = await mindApi.addCanvasItem(canvasId, { nodeId: note.id, x, y, z: nextCanvasZ() })
    const index = canvasItems.value.findIndex(current => current.id === item.id)
    if (index === -1) canvasItems.value.push(item)
    else canvasItems.value[index] = item
    return item
  }

  async function addRefToCanvas(canvasId: number, refType: 'project' | 'file' | 'event', refId: number, x: number, y: number) {
    const node = await mindApi.createRefNode(refType, refId)
    const item = await mindApi.addCanvasItem(canvasId, { nodeId: node.id, x, y, z: nextCanvasZ() })
    const index = canvasItems.value.findIndex(current => current.id === item.id)
    if (index === -1) canvasItems.value.push(item)
    else canvasItems.value[index] = item
    return item
  }

  /** 抽屉拖项目进画布专用：先本地插入一张占位卡，换取拖拽落地动画立刻有真实 DOM 可交接
   * （不用等 createRefNode + addCanvasItem 两次串行请求，克隆体才不会在空中顿住）。接口
   * 成功后原地换成真实数据，失败则原地摘除并把错误抛给调用方。clientKey 全程不变，配合
   * MindCanvas.vue 的 `:key="item.clientKey ?? item.id"`，换真实数据这一步不会触发 Vue
   * 重新挂载、把正在播的落地动画/过渡状态炸掉。 */
  function addProjectRefOptimistic(canvasId: number, projectId: number, x: number, y: number) {
    const tempId = --optimisticSeq
    const clientKey = `optimistic-${tempId}`
    const now = new Date().toISOString()
    const z = nextCanvasZ()
    const placeholder: MindCanvasItem = {
      id: tempId,
      clientKey,
      canvasId,
      nodeId: tempId,
      x, y, w: null, h: null, z,
      collapsed: false,
      data: {},
      node: {
        id: tempId, kind: 'ref', title: null, contentMd: '', color: null,
        capturedAt: now, version: 0, createdAt: now, updatedAt: now,
        refType: 'project', refId: projectId,
      },
      createdAt: now, updatedAt: now,
    }
    canvasItems.value.push(placeholder)

    const ready = (async () => {
      try {
        const node = await mindApi.createRefNode('project', projectId)
        const item = await mindApi.addCanvasItem(canvasId, { nodeId: node.id, x, y, z })
        const resolved = { ...item, clientKey }
        const index = canvasItems.value.findIndex(current => current.clientKey === clientKey)
        if (index === -1) canvasItems.value.push(resolved)
        else canvasItems.value[index] = resolved
        return resolved
      } catch (error) {
        const index = canvasItems.value.findIndex(current => current.clientKey === clientKey)
        if (index !== -1) canvasItems.value.splice(index, 1)
        throw error
      }
    })()

    return { item: placeholder, ready }
  }

  async function createCanvasNote(canvasId: number, data: MindCanvasNoteCreate) {
    const item = await mindApi.createCanvasNote(canvasId, { ...data, z: nextCanvasZ() })
    canvasItems.value.push(item)
    return item
  }

  async function updateCanvasNote(nodeId: number, fields: { title?: string; contentMd?: string; color?: string | null }) {
    const item = canvasItems.value.find(current => current.nodeId === nodeId)
    if (!item) return
    let updated: MindNote
    try {
      updated = await mindApi.updateCanvasNote(nodeId, { ...fields, version: item.node.version })
    } catch (e: any) {
      // 跟 updateNote 同一套乐观锁 409 处理（见其注释）——画布便签也是同一份 MindNode，
      // 理论上一样可能撞并发编辑。
      if (e?.status === 409) throw new MindConflictError()
      throw e
    }
    item.node = updated
    return updated
  }

  function nextCanvasZ() {
    return canvasItems.value.reduce((top, item) => Math.max(top, item.z), 0) + 1
  }

  async function updateCanvasItem(itemId: number, fields: Partial<Pick<MindCanvasItem, 'x' | 'y' | 'w' | 'h' | 'z' | 'collapsed' | 'data'>>) {
    const canvasId = activeCanvasId.value
    const index = canvasItems.value.findIndex(item => item.id === itemId)
    if (canvasId == null || index === -1) return
    const before = canvasItems.value[index]
    canvasItems.value[index] = { ...before, ...fields }
    try {
      const updated = await mindApi.updateCanvasItem(canvasId, itemId, fields)
      const currentIndex = canvasItems.value.findIndex(item => item.id === itemId)
      if (currentIndex !== -1) {
        // 抽屉来源的乐观节点以 clientKey 作为 Vue 的稳定身份。首次落库后若把服务端响应
        // 直接整体替换，会丢掉这个仅前端存在的字段，key 从 clientKey 突然切到真实 id，
        // 正在播的第二次拖拽落地动画便会重挂载、瞬移到最终本体位置。
        canvasItems.value[currentIndex] = {
          ...updated,
          clientKey: canvasItems.value[currentIndex].clientKey,
        }
      }
    } catch (error) {
      const currentIndex = canvasItems.value.findIndex(item => item.id === itemId)
      if (currentIndex !== -1) canvasItems.value[currentIndex] = before
      throw error
    }
  }

  async function removeCanvasItem(itemId: number) {
    const canvasId = activeCanvasId.value
    if (canvasId == null) return
    await mindApi.removeCanvasItem(canvasId, itemId)
    canvasItems.value = canvasItems.value.filter(item => item.id !== itemId)
    const nodeIds = new Set(canvasItems.value.map(item => item.nodeId))
    canvasRelations.value = canvasRelations.value.filter(rel => nodeIds.has(rel.srcNodeId) && nodeIds.has(rel.dstNodeId))
  }

  /** 从画布拖回抽屉：先摘本地展示项让物理克隆能吸入抽屉，删除失败再把原项和关系原样放回。 */
  function returnCanvasItemToDrawer(itemId: number) {
    const canvasId = activeCanvasId.value
    const index = canvasItems.value.findIndex(item => item.id === itemId)
    if (canvasId == null || index === -1) return Promise.resolve()
    const item = canvasItems.value[index]
    const relations = canvasRelations.value
    canvasItems.value.splice(index, 1)
    const nodeIds = new Set(canvasItems.value.map(current => current.nodeId))
    canvasRelations.value = canvasRelations.value.filter(rel => nodeIds.has(rel.srcNodeId) && nodeIds.has(rel.dstNodeId))
    return mindApi.removeCanvasItem(canvasId, itemId).catch(error => {
      window.setTimeout(() => {
        if (activeCanvasId.value !== canvasId || canvasItems.value.some(current => current.id === item.id)) return
        canvasItems.value.splice(Math.min(index, canvasItems.value.length), 0, item)
        canvasRelations.value = relations
      }, 700)
      throw error
    })
  }

  async function createCanvasRelation(srcNodeId: number, dstNodeId: number, allowParallel = false) {
    const relation = await mindApi.createRelation(srcNodeId, dstNodeId, allowParallel)
    if (!canvasRelations.value.some(current => current.id === relation.id)) canvasRelations.value.push(relation)
    return relation
  }

  async function removeCanvasRelation(id: number) {
    await mindApi.deleteRelation(id)
    canvasRelations.value = canvasRelations.value.filter(relation => relation.id !== id)
  }

  /** 画布的视图状态共用 data_json：每次只合并自己负责的键，不能让延迟保存的相机位置覆盖
   *  已冻结的关系锚点。 */
  async function updateCanvasData(id: number, patch: Record<string, unknown>) {
    const index = canvases.value.findIndex(canvas => canvas.id === id)
    if (index === -1) return
    const current = canvases.value[index]
    // 先写本地，连续的视角/关系保存都会基于最新快照合并，不会彼此丢字段。
    canvases.value[index] = { ...current, data: { ...current.data, ...patch } }
    const previous = canvasDataSaves.get(id) ?? Promise.resolve()
    const save = previous.catch(() => {}).then(async () => {
      const latestIndex = canvases.value.findIndex(canvas => canvas.id === id)
      if (latestIndex === -1) return
      // 取队列执行时的完整快照：延迟的相机保存和刚建关系的锚点无论谁先发起，最后写出的
      // 都含有两者，不会出现旧请求后到而把 relationAnchors 冲掉。
      const latest = canvases.value[latestIndex]
      const updated = await mindApi.updateCanvas(id, { data: latest.data })
      const currentIndex = canvases.value.findIndex(canvas => canvas.id === id)
      if (currentIndex !== -1) canvases.value[currentIndex] = { ...updated, data: canvases.value[currentIndex].data }
    })
    canvasDataSaves.set(id, save)
    try {
      await save
    } finally {
      if (canvasDataSaves.get(id) === save) canvasDataSaves.delete(id)
    }
  }

  /** 记住这张画布上次的平移/缩放，下次打开时回到用户离开时的视角。 */
  async function saveCanvasView(id: number, view: { x: number; y: number; scale: number }) {
    await updateCanvasData(id, view)
  }

  async function saveCanvasRelationAnchors(id: number, anchors: Record<string, RelationAnchorSides>) {
    await updateCanvasData(id, { relationAnchors: anchors })
  }

  // 实时：咕咕/IM 改了便签 → 时间流列表刷新；当前打开的画布也重拉，卡片上的笔记正文才能跟着更新
  // （画布卡片渲染的是 loadCanvas 拉回来的快照，不是 notes 数组本身，两处都要刷）。
  const live = useLiveStore()
  watch(() => live.rev.mind, () => {
    if (loaded.value) fetchNotes()
    if (activeCanvasId.value != null) loadCanvas(activeCanvasId.value)
  })

  return {
    notes, loading, loaded, filterQ, jumpTarget, timeline, fetchNotes, createNote, updateNote, deleteNote,
    canvases, canvasesLoaded, canvasLoading, activeCanvasId, canvasItems, canvasRelations,
    fetchCanvases, createCanvas, renameCanvas, deleteCanvas, loadCanvas, addNoteToCanvas, updateCanvasItem,
    addRefToCanvas, addProjectRefOptimistic, createCanvasNote, updateCanvasNote, removeCanvasItem, returnCanvasItemToDrawer, createCanvasRelation, removeCanvasRelation, nextCanvasZ,
    saveCanvasView, saveCanvasRelationAnchors,
  }
})
