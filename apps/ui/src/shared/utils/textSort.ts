// Intl.Collator 预编译，5-10x 快于 .localeCompare() 回调里反复构造。
// 'zh' locale + numeric:true 让 "文件 10" > "文件 4"，跟系统文件管理器 (Finder/Explorer)
// 行为一致——之前直接 .localeCompare() 字典序排序时 "10" 会排在 "4" 前面，
// 这正是用户报告的文件名排序 bug。
// 对纯 ASCII 字符串（ISO 时间/日期/UUID/ext）行为不变——数字按字符序等价于数值序。
const naturalCollator = new Intl.Collator('zh', { numeric: true })
const codeCollator = new Intl.Collator('zh')

/**
 * 自然数序比较：含数字按数值排（"文件 10" > "文件 4"，"02月" > "1月"）。
 * 用于文件名、displayName、name、stageName、年份、月份等"用户语义排序"。
 * dir 由调用方在 compare 闭包里乘上（保持跟 .sort() 标准签名一致）。
 */
export function naturalCompare(a: string, b: string): number {
  return naturalCollator.compare(a ?? '', b ?? '')
}

/**
 * 字典序比较：纯字符串排序，数字按字符序。语义上跟裸 .localeCompare() 一致。
 * 用于 ISO 时间/日期/扩展名等"非语义排序"——naturalCompare 也能用，这个更显式。
 */
export function codeCompare(a: string, b: string): number {
  return codeCollator.compare(a ?? '', b ?? '')
}
