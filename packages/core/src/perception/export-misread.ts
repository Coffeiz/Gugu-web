import {strip} from '../shared/values.js'

/** 全局错读文档的只读下载；读取错误原样传播，仅空内容使用真实基线的空文案。 */
export function createMisreadMarkdownExporter(readText:()=>Promise<string>){
 return async():Promise<string>=>strip(await readText())||'# 错读反思记录\n\n暂无——需发生一次「感知误读 + 用户纠正」才会记一条。\n'
}
