import { z } from 'zod'

export const selectionSnapshotSchema = z.object({
  location: z.string().min(1).max(4096),
  content: z.string().min(1).max(8000),
  unsaved: z.boolean().optional(),
  version: z.number().int().nonnegative().optional(),
  rendered: z.boolean().optional(),
}).strict()

export type SelectionSnapshot = z.infer<typeof selectionSnapshotSchema>

export function selectionReferenceFields(value: unknown): Record<string, unknown> {
  const parsed = selectionSnapshotSchema.safeParse(value)
  if (!parsed.success) return {}
  const { location, content, unsaved, rendered, version } = parsed.data
  return {
    选区位置: location,
    选取时版本: version,
    选区原文: content,
    选区说明: unsaved ? '选区含未保存内容，保存并重新读取后才能应用修改。'
      : rendered ? '选区来自渲染预览，修改前须在当前源码中唯一匹配原文。'
      : '修改前须重新读取当前来源并核对原文与范围。',
  }
}
