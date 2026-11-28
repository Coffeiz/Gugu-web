import { strip } from '../../shared/values.js'
import { normalizeAttentionText } from './normalization.js'

const personReference = new Set(Array.from('我你您他她它咱俺吾人谁各众全群'))
const reportingRoots = new Set(Array.from('说讲问答回听知懂想觉得称提写引述记报'))
const questionOperators = new Set(Array.from('谁哪几怎咋啥何'))
const grammar = new Set(Array.from('我你您他她它咱俺吾们人谁各众全群这那此该其某哪啥个些种样事物前后上下里外内旁边左右近远什么怎何为几多少否可能是还或与吗呢吧啊呀哦嘛请帮替给让使叫快先再试务必不没无别勿莫非未要想愿会应得需肯敢了过着正在已曾将刚又起来去的地得把被对向跟同但而就才因所既并及如咋'))
const specificityNeutral = new Set([...grammar, ...reportingRoots, '咋'])
const ambiguous = new Set(['确实', '离谱', '太好了', '这也行', '怎么这么离谱'])

/** 转述中的疑问不是向当前接收者发问。 */
export function isReportedAttentionUnit(unit: string): boolean {
  const chars = Array.from(normalizeAttentionText(unit))
  const compact = chars.join('')
  if (!compact || compact.startsWith('我想知') || compact.startsWith('我想问')) return false
  const group = ['有人', '别人', '群友'].some(prefix => compact.startsWith(prefix))
  if (personReference.has(chars[0]!) || group) {
    let position = 1
    if (chars[position] === '们') position++
    if (group) position = 2
    while (position < Math.min(chars.length, 6) && '刚才之前'.includes(chars[position]!)) position++
    if (position < chars.length && reportingRoots.has(chars[position]!)) return true
    if (position + 1 < chars.length && '不没无'.includes(chars[position]!) && reportingRoots.has(chars[position + 1]!)) return true
  }
  return chars.length >= 2 && chars[0] === '听' && reportingRoots.has(chars[1]!)
}

function hasQuestionOperator(compact: string): boolean {
  const chars = Array.from(compact)
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!, following = chars[index + 1] || '', previous = chars[index - 1] || ''
    if (char === '哪' && following === '会') continue
    if (questionOperators.has(char)) return true
    if (char === '什' && following === '么') return true
    if (char === '怎' && following && '么样'.includes(following)) return true
    if (char === '为' && following && '什何啥'.includes(following)) return true
    if (char === '多' && following === '少') return true
    if (char === '否' && previous && '是能可'.includes(previous)) return true
    if ('不没'.includes(char) && previous && following === previous) return true
    if (char === '还' && following === '是') return true
  }
  return false
}

/** 按生产算法区分询问、转述和否定劝告，不返回匹配正文。 */
export function questionEvidence(unit: string): [number, boolean] {
  const raw = strip(unit.normalize('NFKC'))
  let compact = normalizeAttentionText(raw)
  if (!compact || isReportedAttentionUnit(raw)) return [0, false]
  const hasMark = raw.includes('?') || raw.includes('？')
  if (hasMark && ambiguous.has(compact)) return [0.85, false]
  let scaffold = false
  const chars = Array.from(compact)
  if (chars[0] === '我' && chars.length >= 3 && '想要'.includes(chars[1]!) && '知问'.includes(chars[2]!)) {
    compact = chars.slice(3).join(''); scaffold = true
  } else if (chars[0] === '想' && chars.length >= 2 && '知问'.includes(chars[1]!)) {
    compact = chars.slice(2).join(''); scaffold = true
  } else if (compact.startsWith('请问')) {
    compact = Array.from(compact).slice(2).join(''); scaffold = true
  }
  const operator = hasQuestionOperator(compact)
  const finalMarker = Array.from(compact).at(-1)
  const hasFinal = finalMarker !== undefined && '吗么呢'.includes(finalMarker)
  if (!(scaffold || operator || hasFinal || hasMark)) return [0, scaffold]
  if (hasMark && !(operator || scaffold) && /(?:别|不要|不必|不用|不需要|无需|勿|莫).{0,12}吧$/u.test(compact)) return [0, scaffold]
  const payload = Array.from(compact).filter(char => !specificityNeutral.has(char))
  if (operator || scaffold) return [payload.length ? 1 : 0.85, scaffold]
  if (hasFinal) return [payload.length > 1 ? 1 : 0.85, scaffold]
  return [hasMark ? 0.85 : 0, scaffold]
}
