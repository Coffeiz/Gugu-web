import {beforeEach,describe,expect,it,vi} from 'vitest'
import {createPinia,setActivePinia} from 'pinia'
import {useFileActions} from '@/composables/files/useFileActions'
const {getStreamUrl,download}=vi.hoisted(()=>({getStreamUrl:vi.fn(),download:vi.fn()}))
vi.mock('@/services/api',()=>({filesApi:{getStreamUrl,download},foldersApi:{}}))
describe('文件流下载',()=>{
 beforeEach(()=>{setActivePinia(createPinia());getStreamUrl.mockReset();download.mockReset()})
 it.each(['/api/v1/files/7/stream','/api/v1/files/7/stream?quality=full#preview'])('给本地地址 %s 添加下载参数',async url=>{
  getStreamUrl.mockResolvedValue({url});let anchor:HTMLAnchorElement|undefined
  const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){anchor=this})
  try {await useFileActions().downloadFile({id:7,displayName:'报告',ext:'TXT'});expect(anchor).toBeDefined();const parsed=new URL(anchor!.href);expect(parsed.origin).toBe(window.location.origin);expect(parsed.pathname).toBe('/api/v1/files/7/stream');expect(parsed.searchParams.get('dl')).toBe('1');expect(parsed.searchParams.get('token')).toBeNull();if(url.includes('quality')){expect(parsed.searchParams.get('quality')).toBe('full');expect(parsed.hash).toBe('#preview')}expect(download).not.toHaveBeenCalled()}finally{click.mockRestore()}
 })
})
