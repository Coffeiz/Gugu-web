function record(value) {
    if (value && typeof value === 'object' && !Array.isArray(value))
        return value;
}
/** 校验机器人身份和 Webhook 状态，供连接设置和轮询启动共用。 */
export async function verifyTelegramBotIdentity(call, expectedId) {
    const bot = record(await call('getMe'));
    const id = bot?.id;
    if (!bot || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
        throw new Error('Telegram Bot 身份无效');
    if (expectedId !== undefined && String(id) !== expectedId)
        throw new Error('Telegram Bot 身份不匹配');
    const webhook = record(await call('getWebhookInfo'));
    if (!webhook)
        throw new Error('Telegram Webhook 状态无效');
    return {
        id,
        ...(typeof bot.username === 'string' ? { username: bot.username } : {}),
        ...(typeof bot.first_name === 'string' ? { first_name: bot.first_name } : {}),
        ...(typeof bot.last_name === 'string' ? { last_name: bot.last_name } : {}),
        webhookUrl: typeof webhook.url === 'string' ? webhook.url : '',
    };
}
