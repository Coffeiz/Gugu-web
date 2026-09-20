export interface QqDeliveryGroup {
  chat_id: string
  title: string
}

export interface QqTargetOption {
  value: string
  label: string
}

export type QqDelivery = { mode: 'private' } | { mode: 'group'; chat_id: string }

/** 保留当前已绑定、但候选群列表暂不可见的群目标，避免表单展示成私聊。 */
export function buildQqTargetOptions(
  groups: QqDeliveryGroup[],
  selectedTarget: string,
  privateLabel: string,
  unavailableGroupLabel: (chatId: string) => string,
): QqTargetOption[] {
  const options: QqTargetOption[] = [
    { value: 'private', label: privateLabel },
    ...groups.map(group => ({ value: group.chat_id, label: group.title })),
  ]
  if (selectedTarget !== 'private' && !groups.some(group => group.chat_id === selectedTarget)) {
    options.push({ value: selectedTarget, label: unavailableGroupLabel(selectedTarget) })
  }
  return options
}

/** 编辑时只提交用户实际变更的 QQ 目标；单改任务字段/渠道不重定向旧群。 */
export function buildQqDeliveryFields(
  isEditing: boolean,
  initialTarget: string,
  selectedTarget: string,
  hasQqChannel: boolean,
): { qq_delivery?: QqDelivery } {
  if (!hasQqChannel || (isEditing && selectedTarget === initialTarget)) return {}
  return {
    qq_delivery: selectedTarget === 'private'
      ? { mode: 'private' }
      : { mode: 'group', chat_id: selectedTarget },
  }
}
