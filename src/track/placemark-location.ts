import type {PlacemarkTimeSource, RoutePosition, TrackPlacemark, TrackPoint} from '../protocol.ts'
import {haversineDistance} from './model/utils.ts'
import {validatePlacemarks} from './placemarks.ts'
import {routeProjectionCandidates} from './profile-placemarks.ts'

export interface PlacemarkRouteContext {
  segmentStarts: number[]
  /** Immutable imported locations, never the edited or added display points. */
  references: TrackPlacemark[]
}
export interface LocatedPlacemark {
  routePosition: RoutePosition
  coordinates: [number, number]
  elevation: number | null
  time: number | null
  timeSource: PlacemarkTimeSource
  distance: number
  partIndex: number
  offset: number
}

const DISTANCE_EPSILON = .001
const REFERENCE_OFFSET = 50
const validPosition = (point: readonly unknown[] | undefined) => !!point && typeof point[0] === 'number' && typeof point[1] === 'number'
  && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90
const validTime = (time: unknown): time is number => typeof time === 'number' && Number.isFinite(time) && Number.isFinite(new Date(time).getTime())
const validElevation = (height: unknown): height is number => typeof height === 'number' && Number.isFinite(height)

/** Structural validation also works while cloning a history snapshot without its track. */
export function validateRoutePosition(value: unknown): RoutePosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('轨迹位置无效')
  const item = value as Partial<RoutePosition>
  if (!Number.isInteger(item.startIndex) || !Number.isInteger(item.endIndex) || item.startIndex! < 0
    || (item.endIndex !== item.startIndex && item.endIndex !== item.startIndex! + 1)
    || typeof item.fraction !== 'number' || !Number.isFinite(item.fraction) || item.fraction < 0 || item.fraction > 1
    || (item.startIndex === item.endIndex && item.fraction !== 0)) throw new Error('轨迹位置无效')
  return {startIndex:item.startIndex!,endIndex:item.endIndex!,fraction:item.fraction}
}

export function validateRouteContext(value: unknown, track: readonly TrackPoint[]): PlacemarkRouteContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('轨迹位置参照无效')
  const item = value as Partial<PlacemarkRouteContext>
  if (!Array.isArray(item.segmentStarts) || item.segmentStarts.length > track.length
    || (track.length ? item.segmentStarts[0] !== 0 : item.segmentStarts.length !== 0)) throw new Error('轨迹分段无效')
  let previous = -1
  for (const index of item.segmentStarts) {
    if (!Number.isInteger(index) || index <= previous || index < 0 || index >= track.length) throw new Error('轨迹分段无效')
    previous = index
  }
  if (!Array.isArray(item.references) || item.references.some(point => !point || point.routePosition !== undefined || point.timeSource !== undefined)) {
    throw new Error('时间参照只能使用原始标注点')
  }
  return {segmentStarts:[...item.segmentStarts],references:validatePlacemarks(item.references)}
}

type TimedPosition = {index:number;distance:number;time:number}
type TimeReference = {distance:number;time:number}
type Measurement = {distances:Float64Array;parts:Int32Array;sampleTimes:Map<number,TimedPosition[]>;references:Map<number,TimeReference[]>}
const measurements = new WeakMap<readonly TrackPoint[],WeakMap<PlacemarkRouteContext,Measurement>>()

function measure(track: readonly TrackPoint[], context: PlacemarkRouteContext): Measurement {
  let byContext = measurements.get(track)
  const cached = byContext?.get(context)
  if (cached) return cached
  const starts = new Set(context.segmentStarts),distances = new Float64Array(track.length),parts = new Int32Array(track.length)
  parts.fill(-1)
  let distance = 0,part = -1,previous = -1
  const sampleTimes = new Map<number,TimedPosition[]>()
  for (let index=0;index<track.length;index++) {
    const point = track[index]
    if (!validPosition(point)) {previous=-1;continue}
    if (previous<0 || starts.has(index)) part++
    else distance += haversineDistance(track[previous][1],track[previous][0],point[1],point[0])
    distances[index]=distance;parts[index]=part;previous=index
    if (validTime(point[3])) {
      const times = sampleTimes.get(part)||[]
      times.push({index,distance,time:point[3]});sampleTimes.set(part,times)
    }
  }
  const references = new Map<number,TimeReference[]>()
  for (const reference of context.references) {
    if (!validTime(reference.time) || reference.routePosition !== undefined || reference.timeSource !== undefined) continue
    const candidates = routeProjectionCandidates(track,reference.coordinates,context.segmentStarts)
    if (candidates.length !== 1 || candidates[0].offset > REFERENCE_OFFSET) continue
    const position=candidates[0],partIndex=parts[position.startIndex]
    if (partIndex<0) continue
    const distance=distances[position.startIndex]+(distances[position.endIndex]-distances[position.startIndex])*position.fraction
    const entries=references.get(partIndex)||[]
    entries.push({distance,time:reference.time});references.set(partIndex,entries)
  }
  for (const [partIndex,entries] of references) {
    entries.sort((a,b)=>a.distance-b.distance)
    const unique:TimeReference[]=[]
    for (let index=0;index<entries.length;) {
      let end=index+1
      while(end<entries.length&&Math.abs(entries[end].distance-entries[index].distance)<=DISTANCE_EPSILON)end++
      if(entries.slice(index,end).every(entry=>entry.time===entries[index].time))unique.push(entries[index])
      index=end
    }
    references.set(partIndex,unique)
  }
  const result={distances,parts,sampleTimes,references}
  if(!byContext){byContext=new WeakMap();measurements.set(track,byContext)}
  byContext.set(context,result)
  return result
}

function interpolateTime(before:TimedPosition|TimeReference|undefined,after:TimedPosition|TimeReference|undefined,distance:number):number|null {
  if(!before||!after||after.time<before.time||after.distance-before.distance<=DISTANCE_EPSILON)return null
  if(distance<before.distance-DISTANCE_EPSILON||distance>after.distance+DISTANCE_EPSILON)return null
  return Math.round(before.time+(after.time-before.time)*(distance-before.distance)/(after.distance-before.distance))
}

function timeAt(track:readonly TrackPoint[],measurement:Measurement,position:RoutePosition,distance:number,partIndex:number):{time:number|null;timeSource:PlacemarkTimeSource} {
  const index=position.startIndex+(position.endIndex-position.startIndex)*position.fraction
  if(position.fraction===0&&validTime(track[position.startIndex][3]))return {time:track[position.startIndex][3],timeSource:'track'}
  if(position.fraction===1&&validTime(track[position.endIndex][3]))return {time:track[position.endIndex][3],timeSource:'track'}
  const samples=measurement.sampleTimes.get(partIndex)||[]
  let low=0,high=samples.length
  while(low<high){const middle=(low+high)>>>1;if(samples[middle].index<index)low=middle+1;else high=middle}
  if(samples[low]?.index===index)return {time:samples[low].time,timeSource:'track'}
  const measured=interpolateTime(samples[low-1],samples[low],distance)
  if(measured!==null)return {time:measured,timeSource:'track'}
  const references=measurement.references.get(partIndex)||[]
  low=0;high=references.length
  while(low<high){const middle=(low+high)>>>1;if(references[middle].distance<distance)low=middle+1;else high=middle}
  const exact=[references[low-1],references[low]].find(entry=>entry&&Math.abs(entry.distance-distance)<=DISTANCE_EPSILON)
  if(exact)return {time:exact.time,timeSource:'estimated'}
  const estimated=interpolateTime(references[low-1],references[low],distance)
  return {time:estimated,timeSource:estimated===null?'unknown':'estimated'}
}

export function derivePlacemarkLocation(track:readonly TrackPoint[],context:PlacemarkRouteContext,value:RoutePosition):LocatedPlacemark {
  const routePosition=validateRoutePosition(value),{startIndex,endIndex,fraction}=routePosition
  const start=track[startIndex],end=track[endIndex]
  if(!validPosition(start)||!validPosition(end)||endIndex>=track.length
    ||(startIndex!==endIndex&&context.segmentStarts.includes(endIndex)))throw new Error('轨迹位置越界或跨越分段')
  const measurement=measure(track,context),partIndex=measurement.parts[startIndex]
  if(partIndex<0||partIndex!==measurement.parts[endIndex])throw new Error('轨迹位置越界或跨越分段')
  let delta=end[0]-start[0]
  if(delta>180)delta-=360
  if(delta< -180)delta+=360
  let lon=start[0]+delta*fraction
  if(lon>180)lon-=360
  if(lon< -180)lon+=360
  const coordinates:[number,number]=[lon,start[1]+(end[1]-start[1])*fraction]
  const elevation=fraction===0&&validElevation(start[2])?start[2]:fraction===1&&validElevation(end[2])?end[2]
    :validElevation(start[2])&&validElevation(end[2])?start[2]+(end[2]-start[2])*fraction:null
  const distance=measurement.distances[startIndex]+(measurement.distances[endIndex]-measurement.distances[startIndex])*fraction
  return {routePosition,coordinates,elevation,...timeAt(track,measurement,routePosition,distance,partIndex),distance,partIndex,offset:0}
}

export function locatePlacemarkCandidates(track:readonly TrackPoint[],context:PlacemarkRouteContext,coordinates:[number,number]):LocatedPlacemark[] {
  if(!Array.isArray(coordinates)||coordinates.length!==2||!validPosition(coordinates))throw new Error('标注点位置无效')
  return routeProjectionCandidates(track,coordinates,context.segmentStarts).map(position=>({
    ...derivePlacemarkLocation(track,context,position),offset:position.offset,
  })).sort((a,b)=>a.partIndex-b.partIndex||a.distance-b.distance||a.routePosition.startIndex-b.routePosition.startIndex)
}
