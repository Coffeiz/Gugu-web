/** 同一条 iLink 消息用于验证桌面收件与服务端密封队列。 */
export const wechatPrivateMessage = {
  message_type: 1,
  message_id: 3,
  from_user_id: 'member-a',
  context_token: 'private-context',
  item_list: [{ type: 1, text_item: { text: '合成微信私聊' } }],
}
