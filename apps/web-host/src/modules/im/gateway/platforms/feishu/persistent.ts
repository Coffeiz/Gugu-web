import { createPersistentFeishuProjection as createProjection, type FeishuProjectionOptions } from '@gugu/gateway/feishu'
import { imAcceptedEvidence, type ImAcceptedSource } from '../../agent/evidence.js'
import type { ImAttachmentScope } from '../../inbound/attachments.js'

/** Web Host 注入图表渲染和出站证据。 */
export function createPersistentFeishuProjection(options: Omit<FeishuProjectionOptions, 'acceptedEvidence'> & {
  acceptedEvidence?: { scope: ImAttachmentScope; recipient: string; source(): Promise<ImAcceptedSource> }
}) {
  const { acceptedEvidence, ...projection } = options
  return createProjection({
    ...projection,
    renderCharts: options.renderCharts ?? (async (request, signal) => (await import('../../../../agent/charts.js')).renderAgentCharts(request, signal)),
    ...(acceptedEvidence ? { acceptedEvidence: {
      scope: acceptedEvidence.scope,
      recipient: acceptedEvidence.recipient,
      async accept({ platformMessageIds, text }) {
        return imAcceptedEvidence({
          scope: acceptedEvidence.scope, recipient: acceptedEvidence.recipient,
          source: await acceptedEvidence.source(), kind: 'text', text,
          receipt: { outcome: 'accepted', platformMessageIds },
        })
      },
    } } : {}),
  })
}
