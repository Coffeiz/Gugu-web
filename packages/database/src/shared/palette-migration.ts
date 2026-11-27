// 固定迁移映射，独立于后续产品色板调整。
export const oldNoteColors = {
  amber: 'project:amber', coral: 'project:rose', blue: 'project:sky', teal: 'project:teal',
} as const
export const oldProjectColor = 'linear-gradient(135deg,#be8b8f,#c8aa72)'
export const amberProjectColor = 'linear-gradient(135deg,#c8aa72,#b88060)'

export const paletteUpdates = `
  UPDATE projects SET color = '${amberProjectColor}' WHERE color = '${oldProjectColor}';
  UPDATE mind_nodes SET color = CASE color
    ${Object.entries(oldNoteColors).map(([old, next]) => `WHEN '${old}' THEN '${next}'`).join(' ')}
    ELSE color END
  WHERE kind IN ('note', 'canvas_note') AND color IN ('amber', 'coral', 'blue', 'teal');
`
