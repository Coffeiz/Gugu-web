/**
 * 文件夹「选择 key」→ 数字 folderId 的换算——纯函数，从 Files/index.vue 抽出。
 *
 * 背景：selectedFolderKeys 里放的是文件夹卡的 `id`（形如 "f:65" 的字符串 key），
 * 而移动/删除/剪切要的是真实数字 `folderId`。绝不能对 key 直接 Number()（"f:65"→NaN，
 * 曾因此导致移动全部落空）。这里按「当前层文件夹列表」查表换算，只解析仍在列表中的 key
 * （不在当前视图的陈旧 key 自然被丢弃）。
 *
 * 过滤用 `v != null`（保留 0，虽然 folderId 恒为正）；原三处调用点分别用 Set / 数组、
 * `!= null` / `Boolean`，因 folderId 恒为正数三者等价，这里统一为 `!= null` 的超集，
 * Set/数组包装留在调用点、不抹平。
 */
export function resolveFolderIds(
  keys: Iterable<string | number>,
  folders: ReadonlyArray<{ id: string | number; folderId: number }>,
): number[] {
  const map = new Map<string | number, number>(folders.map(f => [f.id, f.folderId]))
  return [...keys].map(k => map.get(k)).filter((v): v is number => v != null)
}
