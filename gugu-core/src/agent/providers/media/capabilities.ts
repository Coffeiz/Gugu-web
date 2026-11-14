import type { JsonObject, ProviderConfig } from '../contracts.js'
import { minimaxSupportsImage, minimaxSupportsVideo } from '../minimax/media.js'
import { mimoMediaCapabilities } from '../mimo/media.js'

/** 供协议构建器显式查看，不在Provider层转码或暗中降级媒体。 */
export function vendorMediaCapabilities(config: ProviderConfig): JsonObject {
  if (config.provider === 'mimo') return mimoMediaCapabilities()
  return { supports_image: minimaxSupportsImage(config.model), supports_video: minimaxSupportsVideo(config.model) }
}
