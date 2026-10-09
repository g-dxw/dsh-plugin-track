import {parseShotEditorPlan, type ShotEditorPlan} from './shot-editor.ts'
import {sanitizeLighting, sanitizeSandboxColors} from './map-settings.ts'
import {SHOT_EDITOR_PROJECT_SCHEMA, type ShotEditorProjectInput} from './shot-editor-project-types.ts'

/** The timeline is a view of the native document; camera coordinates never enter its DTO. */
export function parseShotEditorProject(value:unknown,trackId:string):ShotEditorProjectInput|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null
  const raw=value as Partial<ShotEditorProjectInput>,plan=parseShotEditorPlan(raw.plan,trackId)
  if(raw.schema!==SHOT_EDITOR_PROJECT_SCHEMA||!plan||!raw.appearance||typeof raw.appearance!=='object')return null
  const appearance=raw.appearance
  if(!appearance.lighting||!appearance.sandboxColors||!['solid','environment'].includes(appearance.sandboxBackground))return null
  return {schema:SHOT_EDITOR_PROJECT_SCHEMA,plan,appearance:{lighting:sanitizeLighting(appearance.lighting),sandboxColors:sanitizeSandboxColors(appearance.sandboxColors),sandboxBackground:appearance.sandboxBackground}}
}
export function retimeShotEditorKey(plan:ShotEditorPlan,lane:'camera'|'route',id:string,time:number):ShotEditorPlan {
  const keys=lane==='camera'?plan.cameraKeyframes:plan.routeKeyframes
  if(!Number.isFinite(time)||time<0||time>plan.duration)throw new Error('关键帧时间须位于镜头时长内')
  if(keys.some(key=>key.id!==id&&Math.abs(key.time-time)<1e-8))throw new Error('此时间已有关键帧，原关键帧保留')
  if(!keys.some(key=>key.id===id))return plan
  const next=structuredClone(plan)
  if(lane==='camera')next.cameraKeyframes=next.cameraKeyframes.map(key=>key.id===id?{...key,time}:key).sort((a,b)=>a.time-b.time)
  else next.routeKeyframes=next.routeKeyframes.map(key=>key.id===id?{...key,time}:key).sort((a,b)=>a.time-b.time)
  return next
}
export function resizeShotEditorDuration(plan:ShotEditorPlan,duration:number):ShotEditorPlan {
  if(!Number.isFinite(duration)||duration<1||duration>1800)throw new Error('镜头时长须为 1 至 1800 秒')
  const ratio=duration/plan.duration,next=structuredClone(plan)
  next.duration=duration
  for(const key of [...next.cameraKeyframes,...next.routeKeyframes])key.time*=ratio
  for(const label of next.labels){label.from*=ratio;label.to*=ratio}
  next.caption.from*=ratio;next.caption.to*=ratio
  return next
}
