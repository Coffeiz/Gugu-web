import { z } from 'zod'

export type DtoResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly detail: string }

/** 校验请求 DTO；调用方可显式保留旧接口的错误文案。 */
export function validateDto<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  options: { readonly detail?: string } = {},
): DtoResult<z.output<Schema>> {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, value: result.data }
  if (options.detail !== undefined) return { ok: false, detail: options.detail }

  const detail = result.error.issues.map((issue) => {
    const path = issue.path.map(String).join('.')
    const message = issue.message.replace(/^Invalid input: /, '')
    return path ? `${path}: ${message}` : message
  }).join('；')
  return { ok: false, detail }
}
