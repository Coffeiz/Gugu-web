// 聊天气泡的完整字段集合（TS 转换新增）：字段来自不同代码路径按需附加（默认问候/流式回复/
// 历史消息回填/用户发送各自只带自己用得上的那几个），松散 interface 如实反映这个既有形状，
// 不强行收紧成必填。
export interface ChatMessage {
  id: number
  dbId?: number
  role: string
  text: string
  html?: string | null
  files?: ChatFile[]
  quotedText?: string
  time: string
  streaming?: boolean
  // 群聊消息的发言人标注：ai 不用管；owner 自己发的不用管（右侧气泡不署名）；
  // 群里其他成员填 platformUserName，气泡渲染在左侧并显示这个名字。
  speakerLabel?: string
  platformUserId?: string | null
  _greeting?: boolean
  _greetAnimated?: boolean
  _greetFull?: string
}

// 聊天附件（暂存上传 attach_id / 已落库 file_id 两种来源共用的松散形状，字段来自不同
// 代码路径按需附加，参见 ChatMessage 顶部注释同理）
export interface ChatFile {
  file_id?: number
  attach_id?: string
  name?: string
  ext?: string
  size?: number
  size_bytes?: number
  kind?: string
  mime?: string
  qq_face?: boolean
  quoted?: boolean
  duration?: number
  upload?: boolean
  _thumbUrl?: string
  img_width?: number
  img_height?: number
}

export interface ChatSession {
  id: number
  title: string
  source?: string
  chatType?: string
  // /agent/sessions 已返回这两个 ISO 时间；侧栏用 updatedAt 显示“最后对话时间”。
  updatedAt?: string
  createdAt?: string
}

// 共享给 GuguChat.vue 和 GuguChatSidebar.vue：函数类型 props 在 strictFunctionTypes 下
// 是逆变检查，两边必须用同一个类型别名，不能一边 ImPlatformKey 一边收窄成 string。
export type ImPlatformKey = 'feishu' | 'qq' | 'wechat'
