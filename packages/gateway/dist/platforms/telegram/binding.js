export async function handleTelegramBinding(text, consume, reply) {
    const code = text.split(/\s+/u).slice(1).join(' ');
    const bound = /^\d{6}$/u.test(code) && await consume(code);
    await reply(bound ? '绑定成功。' : '绑定码无效、已过期或已使用，请回到咕咕设置重新生成。');
}
