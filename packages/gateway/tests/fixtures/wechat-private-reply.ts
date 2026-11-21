import { wechatPrivateMessage } from './wechat-private-message.js'

/** 两个宿主发送相同微信私聊回复时使用的业务数据。 */
export const wechatPrivateReply = {
  recipient: wechatPrivateMessage.from_user_id,
  contextToken: wechatPrivateMessage.context_token,
  text: '合成输出',
  deliveryId: 'text',
}
