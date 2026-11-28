import { qqPrivateMessage } from './qq-private-message.js'

export const qqPrivateReply = {
  recipient: qqPrivateMessage.author.user_openid,
  originalMessageId: qqPrivateMessage.id,
  text: '合成输出',
  deliveryId: 'text',
}
