import { feishuPrivateMessage } from './feishu-private-message.js'
import { telegramPrivateMessage } from './telegram-private-message.js'

export const feishuPrivateReply = {
  deliveryId: 'text',
  text: '合成输出',
  recipient: feishuPrivateMessage.sender.sender_id.open_id,
  originalMessageId: feishuPrivateMessage.message.message_id,
}

export const telegramPrivateReply = {
  deliveryId: 'text',
  text: '合成输出',
  recipient: String(telegramPrivateMessage.message.from.id),
  originalMessageId: String(telegramPrivateMessage.message.message_id),
}
