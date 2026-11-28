/** 跨数据库使用的收件标识。连接标识由宿主从可信上下文提供。 */
export interface InboundStorageKey {
  ownerId: string
  platform: string
  connectionId: string
  eventKey: string
}

export type InboundRecordResult = { status: 'queued'; id: string } | { status: 'duplicate' | 'unbound' }
