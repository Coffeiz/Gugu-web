export const mermaidUi = {
  'zh-CN': {
    zoomOut: '缩小图表', zoomIn: '放大图表', resetZoom: '恢复图表大小',
    expand: '放大预览', downloadPng: '下载 PNG', close: '关闭', previewTitle: 'Mermaid 图表预览',
    renderFailed: 'Mermaid 图表渲染失败', downloadFailed: 'PNG 导出失败，请稍后重试。',
    pngTooLarge: '图表超出 PNG 导出限制，请缩小图表后重试。',
  },
  'ja-JP': {
    zoomOut: '図を縮小', zoomIn: '図を拡大', resetZoom: '図のサイズをリセット',
    expand: '拡大プレビュー', downloadPng: 'PNG をダウンロード', close: '閉じる', previewTitle: 'Mermaid 図のプレビュー',
    renderFailed: 'Mermaid 図を描画できませんでした', downloadFailed: 'PNG を出力できませんでした。後でもう一度お試しください。',
    pngTooLarge: '図が PNG 出力の上限を超えています。図を小さくして再試行してください。',
  },
  'en-US': {
    zoomOut: 'Zoom out diagram', zoomIn: 'Zoom in diagram', resetZoom: 'Reset diagram size',
    expand: 'Expand preview', downloadPng: 'Download PNG', close: 'Close', previewTitle: 'Mermaid diagram preview',
    renderFailed: 'Mermaid diagram could not be rendered', downloadFailed: 'PNG export failed. Please try again.',
    pngTooLarge: 'The diagram exceeds PNG export limits. Reduce its size and try again.',
  },
} as const
