export const scheduleUi = {
  'zh-CN': {
    intervalPlaceholder: '例如 15',
    onceInPast: '单次任务的执行时间必须晚于当前时间',
    qqGroupUnavailable: '原群（当前不可验证）：{chatId}',
    groupUnavailable: '原群（当前不可验证）：{chatId}',
    channelUnavailablePreserved: '平台已暂停，保存仍保留此渠道',
  },
  'ja-JP': {
    intervalPlaceholder: '例: 15',
    onceInPast: '一回限りのタスクは現在より後の日時を指定してください',
    qqGroupUnavailable: '元のグループ（現在確認できません）：{chatId}',
    groupUnavailable: '元のグループ（現在確認できません）：{chatId}',
    channelUnavailablePreserved: '停止中のため保存時も維持',
  },
  'en-US': {
    intervalPlaceholder: 'e.g. 15',
    onceInPast: 'A one-time task must be scheduled in the future',
    qqGroupUnavailable: 'Original group (currently unavailable): {chatId}',
    groupUnavailable: 'Original group (currently unavailable): {chatId}',
    channelUnavailablePreserved: 'Platform paused; destination is preserved',
  },
} as const
