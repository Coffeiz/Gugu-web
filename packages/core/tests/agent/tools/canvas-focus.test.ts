import { expect,it,vi } from 'vitest'
import { createCanvasFocusTools } from '../../../src/agent/tools/canvas.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
it('定位工具只传可信身份和已校验目标，不接受身份扩展，失败及取消不伪造链接',async()=>{
 const getAgentCanvasFocus=vi.fn().mockResolvedValue({canvas_id:3,item_id:7,node_id:19,title:'合成',focus_link:'gugu://focus-canvas/3/19'})
 const registry=createToolRegistry({tools:createCanvasFocusTools({getAgentCanvasFocus}),authorize:async()=>true})
 const scope={identity:{ownerId:'owner',sessionId:'s',runId:'r'},roundId:'1',resolution:null,signal:new AbortController().signal,execute:async()=>{throw new Error('不执行进程')}}
 const dispatch=(input:unknown)=>registry.tools.dispatch({id:'focus',name:'canvas_focus_node',input},scope)
 expect(await dispatch({canvas_id:3,item_id:7})).toMatchObject({successful:true,mutated:false,value:{focus_link:'gugu://focus-canvas/3/19'}})
 expect(getAgentCanvasFocus).toHaveBeenCalledExactlyOnceWith('owner',{canvas_id:3,item_id:7},scope.signal)
 expect(await dispatch({canvas_id:3,item_id:7,ownerId:'other'})).toMatchObject({successful:false,executed:false})
 expect(await dispatch({canvas_id:true,item_id:7})).toMatchObject({successful:false,executed:false})
 expect(getAgentCanvasFocus).toHaveBeenCalledTimes(1)
 getAgentCanvasFocus.mockResolvedValue({error:'画布节点不存在'})
 expect(await dispatch({canvas_id:3,item_id:7})).toMatchObject({successful:false})
 const controller=new AbortController()
 getAgentCanvasFocus.mockImplementation(async()=>{controller.abort();return {error:'画布节点不存在'}})
 await expect(registry.tools.dispatch({id:'cancel',name:'canvas_focus_node',input:{canvas_id:3,item_id:7}},{...scope,signal:controller.signal})).rejects.toThrow()
})
