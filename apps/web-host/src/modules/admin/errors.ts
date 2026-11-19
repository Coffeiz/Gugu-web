export type AdminHttpError = Error & { statusCode: number }

export function adminHttpError(statusCode: number, message: string): AdminHttpError {
  return Object.assign(new Error(message), { statusCode })
}
