export type SearchErrorCode = 'invalid_request' | 'not_found' | 'conflict' | 'storage_error'

/** 搜索包自己的错误类型；宿主可按 code 映射到自己的协议错误。 */
export class SearchError extends Error {
  constructor(readonly code: SearchErrorCode, message: string) {
    super(message)
    this.name = 'SearchError'
  }
}
