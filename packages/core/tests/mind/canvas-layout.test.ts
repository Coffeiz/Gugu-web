import { it,expect } from 'vitest'
import { resolveCanvasPosition,recommendedCanvasSides } from '../../src/mind/canvas-layout.js'
import type { CanvasPosition } from '../../src/mind/canvas-layout.js'

it('视口锚点按缩放和相机换算世界坐标，显式坐标优先但非法偏移必须失败',()=>{
 const data={x:100,y:50,scale:2,viewport:{width:1000,height:800}}
 const anchors: Array<[CanvasPosition['anchor'],[number,number]]>=[['viewport_center',[90,115]],['viewport_top_left',[-26,-1]],['viewport_top_right',[210,-1]],['viewport_bottom_left',[-26,231]],['viewport_bottom_right',[210,231]]]
 for(const [anchor,expected] of anchors)expect(resolveCanvasPosition({anchor},data,null,null)).toEqual(expected)
 expect(resolveCanvasPosition({anchor:'viewport_center',offset_x:5,offset_y:-3},data,null,null)).toEqual([95,112])
 expect(resolveCanvasPosition({x:1,y:2,anchor:'viewport_center',offset_x:50}, {}, null,null)).toEqual([1,2])
 expect(()=>resolveCanvasPosition({x:1} as CanvasPosition,data,null,null)).toThrow('同时提供')
 expect(()=>resolveCanvasPosition({x:1,y:2,offset_x:NaN},data,null,null)).toThrow('offset_x')
 expect(()=>resolveCanvasPosition({anchor:'viewport_center'},{},null,null)).toThrow('视口尺寸')
})
it('auto及near保留旧间距、零宽回退和偏移规则，不能把屏幕位置当世界位置',()=>{
 expect(resolveCanvasPosition(undefined,{x:100,y:50,scale:2},null,null)).toEqual([-10,15])
 expect(resolveCanvasPosition(undefined,{x:true,y:false,scale:0},null,null)).toEqual([40,40])
 expect(resolveCanvasPosition({offset_x:99},{},{x:100,y:20,w:0},null)).toEqual([470,20])
 expect(resolveCanvasPosition({anchor:'near_node',offset_x:5,offset_y:6},{},null,{x:100,y:20,w:300})).toEqual([555,26])
 expect(()=>resolveCanvasPosition({anchor:'near_node'},{},null,null)).toThrow('找不到')
})

it('水平投影不重叠使用相对端点，重叠按中心使用同侧',()=>{
 expect(recommendedCanvasSides({x:0,w:240},{x:300,w:240})).toEqual(['right','left'])
 expect(recommendedCanvasSides({x:300,w:240},{x:0,w:240})).toEqual(['left','right'])
 expect(recommendedCanvasSides({x:100,w:240},{x:100,w:240})).toEqual(['right','right'])
 expect(recommendedCanvasSides({x:120,w:240},{x:100,w:240})).toEqual(['left','left'])
})
