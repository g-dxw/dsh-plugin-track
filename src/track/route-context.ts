import type { TrackRecord } from '../protocol.ts'
import type { RouteAIContext } from '../ai.ts'
import type { TrackAnnotation } from './annotations.ts'
import { analyzeTrack } from './analysis.ts'

/** Send bounded geometry and facts, excluding original files and check-in photographs. */
export function routeAIContext(track: TrackRecord, annotations: readonly TrackAnnotation[], userNotes = ''): RouteAIContext {
  const analysis=analyzeTrack(track.coordinates),coordinates:RouteAIContext['coordinates']=[]
  const indices=new Set<number>([0,Math.max(0,track.coordinates.length-1)])
  for(let index=0;index<Math.min(80,track.coordinates.length);index++)indices.add(Math.round(index*(track.coordinates.length-1)/Math.max(1,Math.min(80,track.coordinates.length)-1)))
  for(const index of [...indices].sort((a,b)=>a-b)){const point=track.coordinates[index];if(point)coordinates.push({index,lon:point[0],lat:point[1],elevation:point[2]})}
  return {name:Array.from(track.name).slice(0,160).join(''),pointCount:track.coordinates.length,distance:analysis.metrics.distance,elevationGain:analysis.metrics.elevationGain,elevationLoss:analysis.metrics.elevationLoss,elevationMin:analysis.metrics.elevationMin,elevationMax:analysis.metrics.elevationMax,duration:analysis.metrics.duration,
    elevationCoverage:track.coordinates.length?analysis.elevationPoints/track.coordinates.length:0,timestampCoverage:track.coordinates.length?analysis.timestampPoints/track.coordinates.length:0,
    coordinates:coordinates.slice(0,80),annotations:annotations.map(({pointIndex,label,kind})=>({pointIndex,label,...(kind?{kind}:{})})),
    restCandidates:analysis.restCandidates.slice(0,40).map(({startIndex,endIndex,duration})=>({startIndex,endIndex,duration})),userNotes:userNotes.trim().slice(0,4000)}
}