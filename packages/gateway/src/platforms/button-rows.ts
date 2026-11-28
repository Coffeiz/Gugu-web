/** 按标签的估算宽度顺序分行，中文、全角字符和 emoji 按两个单位计。 */
export function packButtonRows<Button>(buttons: readonly Button[], label: (button: Button) => string, maxPerRow: number): Button[][] {
  const rows: Button[][] = []
  let row: Button[] = []
  let rowWidth = 0
  for (const button of buttons) {
    let width = 4
    for (const char of label(button)) width += char.codePointAt(0)! > 0x2E7F ? 2 : 1
    if (row.length && (row.length >= maxPerRow || rowWidth + width > 40)) {
      rows.push(row)
      row = []
      rowWidth = 0
    }
    row.push(button)
    rowWidth += width
  }
  if (row.length) rows.push(row)
  return rows
}
