/** 宿主验证会话并绑定请求目的地与授权凭据。 */
export type BindRemoteRequest<Session> = (session: Session) =>
  ((path: string, init: RequestInit) => Promise<Response>) | null
