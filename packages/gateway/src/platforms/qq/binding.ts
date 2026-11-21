export async function handleQqBinding(text: string, consume: (code: string) => Promise<boolean>, reply: (text: string) => Promise<void>) {
 const code = /^(?:绑定\s*|bind\s*)?([0-9]{6})$/iu.exec(text.trim())?.[1]
 if (!code) return false
 const bound = await consume(code)
 await reply(bound ? 'QQ 身份已绑定，之后可以正常使用。' : '验证码无效或已过期，请回咕咕设置重新生成。')
 return true
}
