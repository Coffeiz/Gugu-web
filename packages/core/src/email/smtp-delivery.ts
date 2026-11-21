import nodemailer from 'nodemailer'
import { resolvePinnedTarget } from '../agent/providers/transport/network.js'
import {environmentCa} from '../agent/providers/transport/node.js'
import {SmtpDeliveryFailure,type SmtpTestDelivery} from './smtp-test.js'
/** SSL或强制STARTTLS，认证可为空；每次调用读取CA并关闭独立连接。 */
export function createSmtpTestDelivery(env:NodeJS.ProcessEnv, publicOnly = false) {
 return async(delivery:SmtpTestDelivery, signal?:AbortSignal):Promise<void>=>{
  signal?.throwIfAborted()
  const ca=environmentCa(env)
  const host = publicOnly ? (await resolvePinnedTarget(`https://${delivery.host}:${delivery.port}`, { timeoutMs: 5000, signal })).target.address : delivery.host
  const transport=nodemailer.createTransport({host,port:delivery.port,secure:delivery.secure,requireTLS:!delivery.secure,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:15000,...(delivery.user?{auth:{user:delivery.user,pass:delivery.password}}:{}),disableFileAccess:true,disableUrlAccess:true,tls:{...(publicOnly?{servername:delivery.host}:{}),rejectUnauthorized:true,...(ca?{ca}:{})}})
  let rejectAbort: ((reason?: unknown) => void) | undefined
  const abort = () => { transport.close(); rejectAbort?.(signal?.reason) }
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  signal?.addEventListener('abort', abort, { once: true })
  try {
   signal?.throwIfAborted()
   const pending = transport.sendMail({
    from: delivery.fromAddress ? { name: delivery.fromName, address: delivery.fromAddress } : '',
    to: delivery.toAddress,
    subject: delivery.message.subject,
    text: delivery.message.plain,
    html: delivery.message.html,
    attachments: [
     ...delivery.message.images.map(image => ({
      filename: image.filename, content: Buffer.from(image.base64, 'base64'), cid: image.cid,
      contentType: 'image/png', contentDisposition: 'inline',
     })),
     ...(delivery.attachments ?? []).map(file => ({
      filename: file.filename, content: Buffer.from(file.content),
      contentType: file.mimeType, contentDisposition: file.cid ? 'inline' : 'attachment',
      ...(file.cid ? { cid: file.cid } : {}),
     })),
    ],
   })
   const receipt = await Promise.race([pending, cancelled])
   if (publicOnly && receipt.rejected?.length) throw new SmtpDeliveryFailure('delivery')
  } catch(error) {
   const message=error instanceof Error?error.message:''
   throw new SmtpDeliveryFailure(/wrong.version.number/i.test(message)?'tls_mismatch':/certificate|self.signed|\bssl\b|\btls\b/i.test(message)?'tls':'delivery')
  }finally{signal?.removeEventListener('abort', abort);transport.close()}
 }
}
