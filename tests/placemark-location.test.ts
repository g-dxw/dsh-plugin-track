import {describe, expect, it} from 'vitest'
import type {TrackPlacemark, TrackPoint} from '../src/protocol.ts'
import {derivePlacemarkLocation, locatePlacemarkCandidates, validateRouteContext, validateRoutePosition, type PlacemarkRouteContext} from '../src/track/placemark-location.ts'

const sample = (lon:number, lat=0, elevation:number|null=null, time:number|null=null):TrackPoint => [lon,lat,elevation,time]
const reference = (id:string, lon:number, time:number, extra:Partial<TrackPlacemark>={}):TrackPlacemark => ({id,name:'',description:'',images:[],coordinates:[lon,0],time,...extra})
const context = (references:TrackPlacemark[]=[], segmentStarts=[0]):PlacemarkRouteContext => ({references,segmentStarts})
const at = (track:TrackPoint[], fraction=.5, references:TrackPlacemark[]=[]) => derivePlacemarkLocation(track,context(references),{startIndex:0,endIndex:1,fraction})

describe('explicit route positions and sampled metadata',()=>{
  it('interpolates coordinates, elevation and sampled time at the selected segment',()=>{
    const value=at([sample(0,0,100,1000),sample(.002,0,300,3000)],.25)
    expect(value).toMatchObject({coordinates:[.0005,0],elevation:150,time:1500,timeSource:'track',partIndex:0,offset:0,routePosition:{startIndex:0,endIndex:1,fraction:.25}})
    expect(value.distance).toBeCloseTo(55.59754,3)
  })
  it('uses sampled time before contradicting original annotations',()=>{
    expect(at([sample(0,0,null,1000),sample(.002,0,null,3000)],.5,[reference('a',0,9000),reference('b',.002,12000)])).toMatchObject({time:2000,timeSource:'track'})
  })
  it('keeps zero epoch and null elevation instead of treating them as absent',()=>{
    const track=[sample(0,0,null,0),sample(.002,0,300,3000)]
    expect(at(track,0)).toMatchObject({elevation:null,time:0,timeSource:'track'})
    expect(at(track,.5)).toMatchObject({elevation:null,time:1500,timeSource:'track'})
    expect(at(track,1)).toMatchObject({elevation:300,time:3000,timeSource:'track'})
  })
  it('interpolates across missing sample times by measured distance within the same part',()=>{
    const track=[sample(0,0,null,1000),sample(.001),sample(.003),sample(.004,0,null,5000)]
    expect(derivePlacemarkLocation(track,context(),{startIndex:1,endIndex:2,fraction:.25})).toMatchObject({time:2500,timeSource:'track'})
  })
  it('does not extrapolate a single sampled time or repair decreasing sample times',()=>{
    expect(at([sample(0,0,null,1000),sample(.002)])).toMatchObject({time:null,timeSource:'unknown'})
    expect(at([sample(0,0,null,3000),sample(.002,0,null,1000)])).toMatchObject({time:null,timeSource:'unknown'})
  })
  it('honors the chosen lap instead of reprojecting its repeated coordinates',()=>{
    const track=[sample(0,0,100,1000),sample(.002,0,200,2000),sample(0,0,300,3000)]
    const value=derivePlacemarkLocation(track,context(),{startIndex:1,endIndex:2,fraction:.5})
    expect(value).toMatchObject({coordinates:[.001,0],elevation:250,time:2500,routePosition:{startIndex:1,endIndex:2,fraction:.5}})
    expect(value.distance).toBeCloseTo(333.58524,3)
  })
  it('interpolates over the short date-line crossing',()=>{
    const value=at([sample(179,10,100,1000),sample(-179,10,300,3000)])
    expect(Math.abs(value.coordinates[0])).toBe(180)
    expect(value).toMatchObject({coordinates:[180,10],elevation:200,time:2000})
    expect(value.distance).toBeLessThan(120000)
  })
  it('rejects invalid fractions, nonadjacent indices and explicit segment bridges',()=>{
    const track=[sample(0),sample(.001),sample(.01),sample(.011)]
    for(const position of [null,{startIndex:-1,endIndex:0,fraction:0},{startIndex:0,endIndex:2,fraction:.5},{startIndex:0,endIndex:1,fraction:NaN},{startIndex:0,endIndex:1,fraction:1.1},{startIndex:0,endIndex:0,fraction:.5}]) {
      expect(()=>validateRoutePosition(position)).toThrow()
    }
    expect(()=>derivePlacemarkLocation(track,context([], [0,2]),{startIndex:1,endIndex:2,fraction:.5})).toThrow(/分段/u)
    expect(()=>derivePlacemarkLocation(track,context(),{startIndex:4,endIndex:4,fraction:0})).toThrow()
    expect(()=>derivePlacemarkLocation([sample(0),sample(NaN)],context(),{startIndex:0,endIndex:1,fraction:.5})).toThrow()
  })
  it('never includes the distance of a gap and does not interpolate time across it',()=>{
    const track=[sample(0,0,null,1000),sample(.001),sample(10),sample(10.001,0,null,5000)]
    const ctx=context([], [0,2])
    const value=derivePlacemarkLocation(track,ctx,{startIndex:2,endIndex:3,fraction:.5})
    expect(value).toMatchObject({partIndex:1,time:null,timeSource:'unknown'})
    expect(value.distance).toBeCloseTo(166.79262,3)
    const invalid=[sample(0,0,null,1000),sample(NaN),sample(.002,0,null,5000)]
    expect(derivePlacemarkLocation(invalid,context(),{startIndex:2,endIndex:2,fraction:0}).distance).toBe(0)
  })
})

describe('fixed original annotation time references',()=>{
  const track=[sample(0),sample(.002)]
  it('estimates between bracketing raw references and identifies the source',()=>{
    const refs=[reference('a',0,1000),reference('b',.002,5000)]
    const before=structuredClone(refs)
    expect(at(track,.25,refs)).toMatchObject({time:2000,timeSource:'estimated'})
    expect(refs).toEqual(before)
    expect(at(track,0,refs)).toMatchObject({time:1000,timeSource:'estimated'})
  })
  it('allows hidden raw references and never needs the edited/display points',()=>{
    expect(at(track,.5,[reference('a',0,1000,{hidden:true}),reference('b',.002,5000,{hidden:true})])).toMatchObject({time:3000,timeSource:'estimated'})
  })
  it('does not extrapolate before or after the nearest references',()=>{
    const refs=[reference('a',.0005,1000),reference('b',.0015,5000)]
    expect(at(track,0,refs)).toMatchObject({time:null,timeSource:'unknown'})
    expect(at(track,1,refs)).toMatchObject({time:null,timeSource:'unknown'})
  })
  it('excludes raw references more than 50 meters off the route',()=>{
    const refs=[reference('a',0,1000,{coordinates:[0,.0006]}),reference('b',.002,5000)]
    expect(at(track,.5,refs)).toMatchObject({time:null,timeSource:'unknown'})
    expect(at(track,.5,[reference('a',0,1000,{coordinates:[0,.0003]}),reference('b',.002,5000)])).toMatchObject({time:3000,timeSource:'estimated'})
  })
  it('excludes ambiguous references on repeated passages',()=>{
    const loop=[sample(0),sample(.002),sample(0)]
    expect(at(loop,.5,[reference('a',0,1000),reference('b',.002,5000)])).toMatchObject({time:null,timeSource:'unknown'})
  })
  it('excludes contradictory references at the same mileage and backward reference times',()=>{
    expect(at(track,.5,[reference('a',0,1000),reference('a2',0,2000),reference('b',.002,5000)])).toMatchObject({time:null,timeSource:'unknown'})
    expect(at(track,.5,[reference('a',0,5000),reference('b',.002,1000)])).toMatchObject({time:null,timeSource:'unknown'})
  })
  it('accepts agreeing duplicate times without creating extra interpolation anchors',()=>{
    expect(at(track,.5,[reference('a',0,1000),reference('a2',0,1000),reference('b',.002,5000)])).toMatchObject({time:3000,timeSource:'estimated'})
  })
  it('cannot use a reference from another disconnected part',()=>{
    const parts=[sample(0),sample(.001),sample(.003),sample(.004)]
    expect(derivePlacemarkLocation(parts,context([reference('a',0,1000),reference('b',.004,5000)],[0,2]),{startIndex:0,endIndex:1,fraction:.5})).toMatchObject({time:null,timeSource:'unknown'})
  })
  it('rejects computed/additional references and validates immutable copies',()=>{
    for(const extra of [{timeSource:'estimated' as const},{routePosition:{startIndex:0,endIndex:1,fraction:.5}}]) {
      expect(()=>validateRouteContext(context([reference('a',0,1000,extra)]),track)).toThrow(/原始/u)
    }
    const raw=context([reference('a',0,1000)])
    const normalized=validateRouteContext(raw,track)
    expect(normalized).toEqual(raw)
    expect(normalized.references).not.toBe(raw.references)
    expect(normalized.references[0].coordinates).not.toBe(raw.references[0].coordinates)
    for(const starts of [[],[1],[0,0],[0,2],[0,-1],[0,.5]])expect(()=>validateRouteContext(context([],starts),track)).toThrow(/分段/u)
    expect(validateRouteContext({references:[],segmentStarts:[]},[])).toEqual({references:[],segmentStarts:[]})
  })
})

describe('separate nearby passages and shared vertices',()=>{
  it('returns both adjacent out-and-back passages rather than merging their indices',()=>{
    const track=[sample(0,0,100,1000),sample(.002,0,200,2000),sample(0,0,300,3000)]
    const result=locatePlacemarkCandidates(track,context(),[.001,0])
    expect(result).toHaveLength(2)
    expect(result.map(item=>item.time)).toEqual([1500,2500])
    expect(result.map(item=>item.routePosition)).toEqual([{startIndex:0,endIndex:1,fraction:.5},{startIndex:1,endIndex:2,fraction:.5}])
  })
  it('merges a common turning vertex at the same mileage',()=>{
    const track=[sample(0),sample(.002),sample(0)]
    expect(locatePlacemarkCandidates(track,context(),[.002,0]).map(item=>item.routePosition)).toEqual([{startIndex:1,endIndex:1,fraction:0}])
  })
  it('does not propose every sample inside a five-meter radius on a dense straight route',()=>{
    const track=Array.from({length:20000},(_,index)=>sample(index*.000001))
    const result=locatePlacemarkCandidates(track,context(),[.0100005,.000001])
    expect(result).toHaveLength(1)
    expect(result[0].coordinates[0]).toBeCloseTo(.0100005,10)
  })
  it('looks across repeated stationary fixes when checking local minima',()=>{
    const track=[...Array.from({length:10000},()=>sample(0)),sample(.001)]
    const values=locatePlacemarkCandidates(track,context(),[.00001,0])
    expect(values).toHaveLength(1)
    expect(values[0].coordinates[0]).toBeCloseTo(.00001,10)
    const stationary=Array.from({length:10000},()=>sample(0))
    expect(locatePlacemarkCandidates(stationary,context(),[.00001,0])).toHaveLength(1)
  })
  it('includes a parallel passage only when it is within nearest offset plus five meters',()=>{
    const track=[sample(0),sample(.002),sample(.002,.00003),sample(0,.00003)]
    expect(locatePlacemarkCandidates(track,context(),[.001,0])).toHaveLength(2)
    const distant=[sample(0),sample(.002),sample(.002,.00006),sample(0,.00006)]
    expect(locatePlacemarkCandidates(distant,context(),[.001,0])).toHaveLength(1)
  })
  it('retains matching positions in different source parts and handles isolated valid fixes',()=>{
    const track=[sample(0),sample(.002),sample(0),sample(.002)]
    expect(locatePlacemarkCandidates(track,context([], [0,2]),[.001,0]).map(item=>item.partIndex)).toEqual([0,1])
    expect(locatePlacemarkCandidates([sample(0,0,20,1000)],context(),[.0001,0])).toMatchObject([{routePosition:{startIndex:0,endIndex:0,fraction:0},time:1000,elevation:20}])
    expect(locatePlacemarkCandidates([],context([],[]),[0,0])).toEqual([])
    expect(()=>locatePlacemarkCandidates(track,context(),[NaN,0])).toThrow()
  })
  it('produces a date-line candidate with a short offset and preserves source input',()=>{
    const track=[sample(179,10),sample(-179,10)],before=structuredClone(track)
    const result=locatePlacemarkCandidates(track,context(),[-180,10.00001])
    expect(result).toHaveLength(1)
    expect(result[0].routePosition.fraction).toBeCloseTo(.5,10)
    expect(result[0].offset).toBeLessThan(2)
    expect(track).toEqual(before)
  })
})
