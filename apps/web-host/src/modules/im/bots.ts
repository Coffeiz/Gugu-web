import type {Pool} from 'pg'
import {createUserBotsReader} from '@gugu/core/im/user-bots'
import {decryptEncryptedString} from '../../adapters/security/encrypted-string.js'
export function createPostgresUserBotsReader(pool:Pick<Pool,'query'>,secretKey:string,supportedPlatforms:()=>readonly string[]|Promise<readonly string[]>) {
 return createUserBotsReader((sql,params)=>pool.query(sql,params),value=>decryptEncryptedString(secretKey,value),supportedPlatforms)
}
