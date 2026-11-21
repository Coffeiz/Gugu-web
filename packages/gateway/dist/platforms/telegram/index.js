import { createTelegramBotApi } from './client.js';
import { connectTelegramPolling } from './polling.js';
import { createTelegramSender } from './sender.js';
export * from './client.js';
export * from './polling.js';
export * from './sender.js';
export function createTelegramAdapter(options) {
    const { token } = options;
    const api = createTelegramBotApi({ transport: options.transport });
    return {
        api,
        sender: createTelegramSender({ token, api }),
        connect: (options) => connectTelegramPolling({ ...options, api, token }),
    };
}
export * from './message.js';
export * from './pairing.js';
export * from './delivery.js';
export * from './binding.js';
export * from './media.js';
export * from './persistent.js';
