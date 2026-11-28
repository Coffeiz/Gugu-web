/** 按Python Unicode码点计数遮蔽密钥，保留可识别的首尾字符。 */
export function maskSecret(secret:string):string {
 const characters=Array.from(secret)
 if(!characters.length)return ''
 return characters.length<=8?'•'.repeat(characters.length):`${characters.slice(0,3).join('')}${'•'.repeat(characters.length-7)}${characters.slice(-4).join('')}`
}
