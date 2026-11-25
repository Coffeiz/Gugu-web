import assert from 'node:assert/strict'
import test from 'node:test'
import {isOwnedFilePath} from '../../../src/modules/files/store.js'
test('存储 key 限定本用户并兼容旧数据导入目录',()=>{
 const owner='11111111-1111-4111-8111-111111111111',hex=owner.replaceAll('-','')
 assert.equal(isOwnedFilePath(owner,`${owner}/个人文件/a.txt`),true)
 assert.equal(isOwnedFilePath(owner,`${hex}/.data-portability/imported/job/file`),true)
 assert.equal(isOwnedFilePath(owner,`${hex}/其他/a`),false)
 assert.equal(isOwnedFilePath(owner,'22222222-2222-4222-8222-222222222222/个人文件/a'),false)
})
