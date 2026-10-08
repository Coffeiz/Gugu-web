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
