/**
 * 思维面板 store（P1：只管「记录」这一半）。
 *
 * 时间流按 capturedAt 倒序——补录昨天的想法要落回它「发生」的那天，不能因为刚写就排最前，
 * 所以本地插入/改动后一律重排，不假设「新写的就在最前面」。
 *
 * 便签更新走乐观锁：请求带 version，后端版本对不上回 409。这里把 409 单独抛成
 * `MindConflictError`，调用方（编辑器）据此提示「已被其他端修改」并重新拉取。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { mindApi, type MindNote, type MindNoteCreate, type MindNoteUpdate } from '@/services/api'

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

export const useMindStore = defineStore('mind', () => {
  const notes   = ref<MindNote[]>([])
  const loading = ref(false)
  const loaded  = ref(false)
  const filterQ = ref('')   // 胶囊条的便签筛选（客户端过滤已加载的便签）

  /** 时间流：按 capturedAt 分组成「一天一组」，供 RecordTimeline 渲染；筛选词命中正文才留 */
  const timeline = computed(() => {
    const q = filterQ.value.trim().toLowerCase()
    const pool = q
      ? notes.value.filter(n => plainOf(n.contentMd).toLowerCase().includes(q))
      : notes.value
    const groups: { date: string; items: MindNote[] }[] = []
    for (const n of [...pool].sort(byCapturedDesc)) {
      const date = n.capturedAt.slice(0, 10)
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

  return { notes, loading, loaded, filterQ, timeline, fetchNotes, createNote, updateNote, deleteNote }
})
