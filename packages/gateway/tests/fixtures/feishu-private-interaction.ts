export const feishuPrivateInteraction = {
  schema: '2.0',
  header: { event_type: 'card.action.trigger', app_id: 'cli_0123456789abcdef', event_id: 'card-event' },
  event: {
    operator: { open_id: 'ou_member' },
    context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
    action: { value: { prompt_id: 7, token: 'synthetic-action' } },
  },
}
