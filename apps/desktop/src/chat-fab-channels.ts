export const chatFabChannels = {
  attach: 'gugu:chat-fab:attach',
  dropReferences: 'gugu:chat-fab:drop-references',
  droppedReferences: 'gugu:chat-fab:dropped-references',
  ballDetached: 'gugu:chat-fab:ball-detached',
  material: 'gugu:chat-fab:material',
  dropFiles: 'gugu:chat-fab:drop-files',
  droppedReference: 'gugu:chat-fab:dropped-reference',
  gesture: 'gugu:chat-fab:gesture',
  panelGeometry: 'gugu:chat-fab:panel-geometry',
  panelGeometryDone: 'gugu:chat-fab:panel-geometry-done',
  panelDetached: 'gugu:chat-fab:panel-detached',
  panelExpanded: 'gugu:chat-fab:panel-expanded',
  panelReady: 'gugu:chat-fab:panel-ready',
  panelEntered: 'gugu:chat-fab:panel-entered',
  panelClosing: 'gugu:chat-fab:panel-closing',
  panelClose: 'gugu:chat-fab:panel-close',
  chatVisible: 'gugu:chat-fab:chat-visible',
  closeChat: 'gugu:chat-fab:close-chat',
  openMainReference: 'gugu:chat-fab:open-main-reference',
  openChat: 'gugu:chat-fab:open-chat',
} as const

export type ChatFabGesture = 'down' | 'move' | 'up' | 'cancel' | 'open' | 'ready'
