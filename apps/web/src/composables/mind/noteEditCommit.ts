import type { Ref } from 'vue'

/** 只有保存成功才结束编辑态；失败时保留输入，允许用户修正后重试。 */
export async function commitNoteEdit(
  editing: Ref<boolean>,
  committing: Ref<boolean>,
  save: () => Promise<boolean>,
): Promise<boolean> {
  committing.value = true
  try {
    const saved = await save()
    if (saved) editing.value = false
    return saved
  } finally {
    committing.value = false
  }
}

/** 页面离开时，未保存成功就阻止导航，避免组件卸载丢弃正在编辑的正文。 */
export async function canLeaveNoteEditor(
  editing: boolean,
  finishEdit: () => Promise<boolean>,
): Promise<boolean> {
  return !editing || finishEdit()
}
