import { MindCanvasItemMutationError } from './canvas-item-remove.js'

export interface CanvasPosition {
  x?: number; y?: number; anchor?: 'auto'|'viewport_center'|'viewport_top_left'|'viewport_top_right'|'viewport_bottom_left'|'viewport_bottom_right'|'near_node'
  near_node_id?: number; offset_x?: number; offset_y?: number
}
export interface CanvasGeometry { x:number; y:number; w:number|null }
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)
export function parseCanvasData(raw:string):Record<string,unknown>{
  try{const value:unknown=JSON.parse(raw||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}catch{return {}}
}
function fail(message:string):never{throw new MindCanvasItemMutationError(message,422)}
function validate(position:CanvasPosition) {
  if(('x' in position||'y' in position)&&(!finite(position.x)||!finite(position.y)))fail('position 必须同时提供有效数字 x 和 y，不能回落到自动布局')
  for(const key of ['offset_x','offset_y'] as const)if(key in position&&!finite(position[key]))fail(`position.${key} 必须是有效数字`)
}
function viewportPosition(anchor:string,data:Record<string,unknown>,scale:number,cameraX:number,cameraY:number):[number,number] {
  const viewport=data.viewport&&typeof data.viewport==='object'&&!Array.isArray(data.viewport)?data.viewport as Record<string,unknown>:{}
  if(!finite(viewport.width)||!finite(viewport.height))fail('画布尚未保存视口尺寸，暂时不能按当前视野定位')
  const w=viewport.width/scale,h=viewport.height/scale,x=-cameraX/scale,y=-cameraY/scale
  const shifts:Record<string,[number,number]>={viewport_center:[w/2-110,h/2-60],viewport_top_left:[24,24],viewport_top_right:[w-240,24],viewport_bottom_left:[24,h-144],viewport_bottom_right:[w-240,h-144]}
  const shift=shifts[anchor]!
  return [x+shift[0],y+shift[1]]
}
/** 纯几何规则沿Python layout_engine；无效显式坐标不能回落自动布局。 */
export function resolveCanvasPosition(position:CanvasPosition|undefined,data:Record<string,unknown>,last:CanvasGeometry|null,near:CanvasGeometry|null):[number,number] {
  const p=position??{};validate(p)
  if(finite(p.x)&&finite(p.y))return [p.x,p.y]
  const anchor=p.anchor??'auto',scale=finite(data.scale)&&data.scale>0?data.scale:1,cameraX=finite(data.x)?data.x:0,cameraY=finite(data.y)?data.y:0
  if(!['auto','viewport_center','viewport_top_left','viewport_top_right','viewport_bottom_left','viewport_bottom_right','near_node'].includes(anchor))fail('不支持的画布位置锚点')
  if(anchor.startsWith('viewport_')){
    const [x,y]=viewportPosition(anchor,data,scale,cameraX,cameraY)
    return [x+(p.offset_x||0),y+(p.offset_y||0)]
  }
  if(anchor==='near_node'){
    if(!near)fail('找不到要靠近的画布节点')
    return [near.x+(near.w||220)+150+(p.offset_x||0),near.y+(p.offset_y||0)]
  }
  if(anchor!=='auto')fail('不支持的画布位置锚点')
  return last?[last.x+(last.w||220)+150,last.y]:[-cameraX/scale+40,-cameraY/scale+40]
}

/** 以水平投影判断默认端点；重叠时选同一外侧，不按节点ID猜测。 */
export function recommendedCanvasSides(source:{x:number;w:number},target:{x:number;w:number}):['left'|'right','left'|'right'] {
  if(source.x+source.w<=target.x)return ['right','left']
  if(target.x+target.w<=source.x)return ['left','right']
  return target.x+target.w/2>=source.x+source.w/2?['right','right']:['left','left']
}
