import type { AttentionMessage } from './types.js'
import { normalizeAttentionText } from './normalization.js'
import { visibleAttentionUnits } from './visible-units.js'

export interface CapabilityMatch { strength: 'strong' | 'weak'; start: number; end: number }

const registry = [
  ['待办事项','项目任务','任务项','待办','项目','阶段','任务','定时任务','周期任务','提醒','闹钟','日历事件','日程安排','日历','日程','思维笔记','笔记','记录','思维画布','画布','文件夹','附件','文档','文件','技能','skill','联系人','通讯录','邮件','电子邮件','邮箱','终端','shell','命令行','网页搜索','联网搜索','网页'],
]
const nouns = [...new Set(registry.flat())].sort((a,b)=>Array.from(b).length-Array.from(a).length||a.localeCompare(b,'zh-CN'))
const verbs = '创建 新建 建立 设置 完成 添加 生成 记录 保存 整理 修改 更新 调整 搜索 查找 查看 绘制 删除 取消 停止 关闭 归档 分类 移动 复制 上传 下载 打开 分析 总结 补充 编辑 读取 查询 获取 执行 运行 使用 调用 安装 压缩 解压 发送 展示 浏览 连接 断开 定 设 记 写 画 建 加 改 删 查 找 存 排 看 搜 录 启 停 关 移 传 发 读 做 弄 搞 处理'.split(' ').sort((a,b)=>Array.from(b).length-Array.from(a).length||a.localeCompare(b,'zh-CN'))
const prefixes = ['请帮我','帮我','帮忙','帮大家','麻烦','给我','给大家','替我','替大家','请大家','大家帮忙','请','能不能帮我','能帮我','可以帮我','帮我们','需要','想要','我想','我希望']
const fillers = ['那就','然后','顺便','那么','对了','另外','还有','接下来','接着','随后','好吧','好的','行吧','那好','嗯','那','就','再','请'].sort((a,b)=>b.length-a.length)
const fillerChars = new Set(Array.from('个一这那此该新旧些条张份下来一下的里上中内我你请帮替给快先再'))
const locations = new Set(['里','里面','上','上面','中','内'])
const reported = /^(?:(?:他|她|它|别人|某人|有人|群友)(?:们)?(?:刚才|之前|曾经)?(?:让我|叫我|请我|要我|要求我|建议我|说要|说让我|提到|表示)|(?:有)?用户(?:反馈|表示|提到)|(?:文档|原文)(?:中|里)?(?:写道|提到|说明|表示))/u
const plan = /^(?:(?:我|咱们|我们)?(?:准备|打算|计划|预备|将要)|我想自己|准备自己|打算自己)/u
const completed = /^(?:(?:我|咱们|我们)?(?:已经|已|刚才|刚刚|早就|此前|曾经|完成了|做完了))/u
const negative = /(?:别|不要|不必|不用|不需要|不想|不愿|无需|勿|莫)(?:再|去|帮我|给我)?$/u
const negativeIntent = /(?:我|咱们|我们)?(?:不想|不愿|不希望|不要|不需要|不打算).{0,8}$/u
const evaluation = /(?:这个功能|该功能|功能不错|功能很好|功能很棒|真的方便|真的好用|很方便|挺方便|挺好|很好|挺好用|很好用|不错|很棒|值得推荐|不容易|很简单|很难|很重要|很麻烦|很复杂|很有用|是好事)/u
const indirectReport = /(?:让我|叫我|请我|要我|要求我|建议我|吩咐我)$/u
const completedSuffix = /(?:了|完成|结束|搞定)$/u
const bareTail = /^(?:(?:一下|一个|一份|个)?(?:吧|啊|呀|呢|嘛|啦|哟|呐)?|就行|即可|就好)?$/u

function spans(text:string, lexicon:readonly string[]):Array<[number,number,string]> {
 const candidates:Array<[number,number,string]> = []
 for(const value of lexicon){let from=0;while(true){const at=text.indexOf(value,from);if(at<0)break;candidates.push([at,at+value.length,value]);from=at+1}}
 candidates.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0])||a[0]-b[0]||a[2].localeCompare(b[2]))
 const selected:Array<[number,number,string]>=[]
 for(const item of candidates)if(!selected.some(other=>item[0]<other[1]&&other[0]<item[1]))selected.push(item)
 return selected.sort((a,b)=>a[0]-b[0]||a[1]-b[1])
}
function stripFillers(prefix:string):string {let value=prefix;while(value){const match=fillers.find(item=>value.startsWith(item));if(!match)break;value=value.slice(match.length)}return value}
function hasPrefix(prefix:string):boolean {return prefixes.some(item=>item!=='请'&&prefix.endsWith(item))||(prefix.endsWith('请')&&!stripFillers(prefix.slice(0,-1)))}
function reportedUnit(unit:string):boolean {
 const value=normalizeAttentionText(unit);if(!value||value.startsWith('我想知')||value.startsWith('我想问'))return false
 if(/^(?:他|她|它|别人|某人|有人|群友)/u.test(value))return /(?:说|讲|问|答|回|听|知|懂|想|提|写|让|叫)/u.test(value.slice(1,7))
 return /^(?:用户反馈|用户表示|用户提到|文档(?:中|里)?(?:写道|提到|说明|表示)|原文(?:中|里)?(?:写道|提到|说明|表示))/u.test(value)
}

/** Python v3.0.7 的动作-对象准入规则；start/end 为 Unicode 码点偏移。 */
export function capabilityRequestUnit(unit:string):CapabilityMatch|null {
 const chars=Array.from(unit), normalized=normalizeAttentionText(unit), offsets:number[]=[]
 let cursor=0
 for(let i=0;i<chars.length;i++){const norm=normalizeAttentionText(chars[i]!);for(const _ of norm)offsets.push(i);cursor+=norm.length}
 const text=Array.from(normalized).join(''), firstWant=/^(?:我想|咱们想|我们想)/u.test(text)
 if(!text||(reportedUnit(unit)&&!firstWant)||reported.test(text)||plan.test(text)||completed.test(text)||evaluation.test(text))return null
 const object=spans(text,nouns);if(!object.length)return null
 const actions=spans(text,verbs).filter(span=>{const overlap=object.filter(item=>span[0]<item[1]&&item[0]<span[1]);return !overlap.length||!(overlap.length===1&&span[0]===overlap[0]![0]&&span[1]===overlap[0]![1]&&object.some(item=>item[0]!==span[0]||item[1]!==span[1]))})
 if(/不要再$/u.test(text.slice(0,object[0]![0]))&&object.some(item=>['提醒','闹钟','定时任务','周期任务'].includes(item[2]))){const [s,e]=object[0]!;return {strength:'strong',start:offsets[s]??0,end:(offsets[e-1]??chars.length-1)+1}}
 const map=(a:number,b:number,o:number,p:number,strength:'strong'|'weak'):CapabilityMatch=>({strength,start:offsets[Math.min(a,o)]??0,end:(offsets[Math.max(b,p)-1]??chars.length-1)+1})
 for(const [as,ae] of actions)for(const [os,oe] of object){const prefix=text.slice(0,as);if(indirectReport.test(prefix)||negative.test(prefix)||negativeIntent.test(prefix))continue
  if(ae<=os){const gap=Array.from(text.slice(ae,os));if(gap.length>10||gap.some(char=>!fillerChars.has(char)))continue;if(hasPrefix(prefix))return map(as,ae,os,oe,'strong');const bare=stripFillers(prefix);if(!bare&&as<=4&&!/[不别勿莫]/u.test(text.slice(0,as))&&!completedSuffix.test(text.slice(oe))&&bareTail.test(text.slice(oe)))return map(as,ae,os,oe,'weak')}
  else if(oe<=as){const gap=text.slice(oe,as),before=text.slice(0,os),front=before.startsWith('把')||before.startsWith('将')||before.startsWith('给')||locations.has(gap),request=hasPrefix(before);if(Array.from(gap).length<=5&&(front||request)){const later=object.filter(item=>item[0]>=ae);if(locations.has(gap)&&later.length&&!request&&!/^(?:把|将|给)/u.test(before)&&!bareTail.test(text.slice(Math.max(...later.map(item=>item[1])))))continue;return map(as,ae,os,oe,'strong')}}
 }
 // 某些动作同时是能力名词（例如“记录”），最长词项会先占用同一 span。
 // 在请求结构明确且后面另有业务对象时，保留这类动作的自然用法。
 for(const verb of verbs){let at=text.indexOf(verb);while(at>=0){const end=at+verb.length,exact=object.some(item=>item[0]===at&&item[1]===end),later=object.find(item=>item[0]>=end&&item[1]>end)
   if(exact&&later){const prefix=text.slice(0,at),gap=text.slice(end,later[0]);if(!indirectReport.test(prefix)&&!negative.test(prefix)&&!negativeIntent.test(prefix)&&Array.from(gap).length<=10&&Array.from(gap).every(char=>fillerChars.has(char))){
     if(hasPrefix(prefix))return map(at,end,later[0],later[1],'strong')
     if(!stripFillers(prefix)&&at<=4&&!/[不别勿莫]/u.test(prefix)&&!completedSuffix.test(text.slice(later[1]))&&bareTail.test(text.slice(later[1])))return map(at,end,later[0],later[1],'weak')
   }}
   at=text.indexOf(verb,at+1)
  }}
 return null
}

export function capabilityActionEvidence(message:AttentionMessage):{match:CapabilityMatch;position:number;weight:number}|null {
 const source=message.candidateText||message.rawText,{units,visiblePrefix}=visibleAttentionUnits(source),visibleLength=visiblePrefix.at(-1)??0
 for(const unit of units){const match=capabilityRequestUnit(unit.text);if(!match)continue;const start=unit.start+match.start,end=unit.start+match.end,position=visibleLength?(visiblePrefix[start]!+visiblePrefix[end]!)/(2*visibleLength):.5,alpha=Math.min(1,Math.max(0,(visibleLength-200)/600)),edge=.55+.45*Math.abs(2*position-1),weight=1-alpha*(1-edge);return {match:{...match,start,end},position,weight}}
 return null
}
