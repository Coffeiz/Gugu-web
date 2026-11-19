/** 各资源撤销适配器共用的冲突类型。 */
export class MindUndoConflict extends Error {
  readonly code = 'undo.conflict'
  constructor(message = '资源已被其他操作修改，无法安全撤回') { super(message) }
}

export class MindUndoUnsupported extends Error {
  readonly code = 'undo.unsupported'
  constructor() { super('撤销记录包含未知画布资源') }
}
