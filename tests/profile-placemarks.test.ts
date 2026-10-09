import {describe, expect, it} from 'vitest'
import {projectProfilePlacemarks} from '../src/track/profile-placemarks.ts'
import type {TrackPlacemark, TrackPoint} from '../src/protocol.ts'

const point = (lon:number, lat:number):TrackPoint => [lon,lat,null,null]
function marker(id:string,lon:number,lat:number):TrackPlacemark {
  return {id,name:'',coordinates:[lon,lat],description:'',images:[]}
}
function projection(points:readonly TrackPoint[],lon:number,lat:number) {
  return projectProfilePlacemarks(points,[marker('point',lon,lat)])[0]
}

describe('source markers projected onto profile path segments',()=>{
  it('projects a marker to the middle of the nearest segment instead of a nearby sample',()=>{
    const result=projection([point(120,30),point(120.02,30)],120.01,30.001)
    expect(result).toMatchObject({id:'point',number:1,startIndex:0,endIndex:1})
    expect(result.fraction).toBeCloseTo(.5,10)
  })

  it('uses the nearest part of a winding path',()=>{
    const result=projection([point(0,0),point(1,0),point(1,1),point(0,1)],.25,.8)
    expect(result).toMatchObject({startIndex:2,endIndex:3})
    expect(result.fraction).toBeCloseTo(.75,10)
  })

  it('keeps the first crossing segment when several laps are equally close',()=>{
    const points=[point(-1,-1),point(1,1),point(-1,1),point(1,-1)]
    expect(projection(points,0,0)).toMatchObject({startIndex:0,endIndex:1,fraction:.5})
  })

  it('keeps the earliest source segment on a retraced route',()=>{
    expect(projection([point(0,0),point(1,0),point(0,0),point(1,0)],.25,0)).toMatchObject({startIndex:0,endIndex:1,fraction:.25})
  })

  it('preserves independent source numbers for markers at the same location',()=>{
    const result=projectProfilePlacemarks([point(0,0),point(1,0)],[marker('a',.5,0),marker('b',.5,0),marker('c',.5,0)])
    expect(result).toEqual(['a','b','c'].map((id,index)=>({id,number:index+1,startIndex:0,endIndex:1,fraction:.5})))
  })

  it('does not sort the supplied route coordinates or markers',()=>{
    const points=[point(2,0),point(0,0),point(0,2),point(2,2)]
    const marks=[marker('last',1,2),marker('first',1,0)]
    expect(projectProfilePlacemarks(points,marks)).toEqual([
      {id:'last',number:1,startIndex:2,endIndex:3,fraction:.5},
      {id:'first',number:2,startIndex:0,endIndex:1,fraction:.5},
    ])
  })

  it('ignores point elevations and timestamp order when choosing a segment',()=>{
    const points:TrackPoint[]=[[0,0,9000,10000],[1,0,0,0],[1,1,-1000,5000]]
    const marks=[{...marker('a',.5,0),elevation:-99999,time:999999999}]
    expect(projectProfilePlacemarks(points,marks)).toEqual([{id:'a',number:1,startIndex:0,endIndex:1,fraction:.5}])
  })

  it('clamps projection beyond the path to the closest endpoint',()=>{
    expect(projection([point(0,0),point(1,0)],2,0)).toMatchObject({startIndex:0,endIndex:1,fraction:1})
    expect(projection([point(0,0),point(1,0)],-1,0)).toMatchObject({startIndex:0,endIndex:1,fraction:0})
  })
})

describe('date-line crossing and discontinuous coordinates',()=>{
  it('projects to the short eastbound segment across the date line',()=>{
    expect(projection([point(179,10),point(-179,10)],180,10)).toMatchObject({startIndex:0,endIndex:1,fraction:.5})
    expect(projection([point(179,10),point(-179,10)],-180,10)).toMatchObject({startIndex:0,endIndex:1,fraction:.5})
  })

  it('projects a westbound date-line crossing without reversing source indices',()=>{
    expect(projection([point(-179,10),point(179,10)],180,10)).toMatchObject({startIndex:0,endIndex:1,fraction:.5})
  })

  it('keeps the earliest lap when longitude unwrap spans more than one world',()=>{
    const points=Array.from({length:100},(_,index)=>point(((index*30+180)%360)-180,0))
    const result=projection(points,170,0)
    expect(result).toMatchObject({startIndex:5,endIndex:6})
    expect(result.fraction).toBeCloseTo(2/3,10)
  })

  it('does not draw an artificial bridge across an invalid coordinate',()=>{
    const points=[point(0,0),point(Number.NaN,0),point(2,0),point(3,0)]
    expect(projection(points,1,0)).toMatchObject({startIndex:0,endIndex:0,fraction:0})
    expect(projection(points,2.5,0)).toMatchObject({startIndex:2,endIndex:3,fraction:.5})
  })

  it('keeps original indices when invalid fixes precede a usable segment',()=>{
    const points=[point(Infinity,0),point(0,100),point(181,0),point(179,10),point(-179,10)]
    expect(projection(points,-180,10)).toMatchObject({startIndex:3,endIndex:4,fraction:.5})
  })

  it('skips invalid marker locations while preserving their source number slots',()=>{
    const marks=[marker('a',.25,0),marker('invalid',Infinity,0),marker('bad-lat',0,91),marker('b',.75,0)]
    expect(projectProfilePlacemarks([point(0,0),point(1,0)],marks).map(item=>[item.id,item.number])).toEqual([['a',1],['b',4]])
  })

  it('supports a single valid point and an empty path',()=>{
    expect(projection([point(120,30)],120.01,30)).toMatchObject({startIndex:0,endIndex:0,fraction:0})
    expect(projectProfilePlacemarks([], [marker('a',0,0)])).toEqual([])
    expect(projectProfilePlacemarks([point(NaN,0)],[marker('a',0,0)])).toEqual([])
    expect(projectProfilePlacemarks([point(0,0)],[])).toEqual([])
  })

  it('handles duplicate fixes without dividing by zero',()=>{
    expect(projection([point(0,0),point(0,0),point(1,0)],0,0)).toEqual({id:'point',number:1,startIndex:0,endIndex:1,fraction:0})
  })

  it('chooses the first duplicate in a spatial hierarchy rather than depending on box traversal order',()=>{
    const points=Array.from({length:200},()=>point(0,0))
    expect(projection(points,0,0)).toMatchObject({startIndex:0,endIndex:1,fraction:0})
  })

  it('does not mutate frozen inputs when building the spatial index',()=>{
    const points=Object.freeze([Object.freeze(point(0,0)),Object.freeze(point(1,0))]) as unknown as readonly TrackPoint[]
    const marks=Object.freeze([Object.freeze(marker('a',.5,0))])
    expect(projectProfilePlacemarks(points,marks)).toEqual([{id:'a',number:1,startIndex:0,endIndex:1,fraction:.5}])
  })
})

describe('spatial index matches a direct nearest-segment reference',()=>{
  it('finds the same segments on an unordered winding route with many boxes',()=>{
    let seed=12345
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
    const points=Array.from({length:200},()=>point(120+random()*.1,30+random()*.1))
    const marks=Array.from({length:30},(_,index)=>marker(`point-${index}`,120+random()*.1,30+random()*.1))
    const result=projectProfilePlacemarks(points,marks)
    for(let index=0;index<marks.length;index+=1){
      const [lon,lat]=marks[index].coordinates,scale=Math.cos(lat*Math.PI/180)
      let distance=Infinity,startIndex=-1,fraction=0
      for(let candidate=0;candidate<points.length-1;candidate+=1){
        const [x0,y0]=points[candidate], [x1,y1]=points[candidate+1]
        const dx=(x1-x0)*scale,dy=y1-y0,qx=(lon-x0)*scale,qy=lat-y0
        const t=Math.max(0,Math.min(1,(qx*dx+qy*dy)/(dx*dx+dy*dy)))
        const squared=(qx-t*dx)**2+(qy-t*dy)**2
        if(squared<distance-1e-14){distance=squared;startIndex=candidate;fraction=t}
      }
      expect(result[index].startIndex).toBe(startIndex)
      expect(result[index].endIndex).toBe(startIndex+1)
      expect(result[index].fraction).toBeCloseTo(fraction,10)
    }
  })
})

describe('saved route anchors and explicit boundaries',()=>{
  it('keeps an explicitly selected repeated passage even when another is geometrically identical',()=>{
    const points=[point(0,0),point(.002,0),point(0,0)]
    const mark={...marker('second',.001,0),routePosition:{startIndex:1,endIndex:2,fraction:.5}}
    expect(projectProfilePlacemarks(points,[mark])).toEqual([{id:'second',number:1,startIndex:1,endIndex:2,fraction:.5}])
  })
  it('uses singleton vertex anchors and falls back when saved positions are invalid',()=>{
    const points=[point(0,0),point(.002,0),point(0,0)]
    expect(projectProfilePlacemarks(points,[{...marker('end',0,0),routePosition:{startIndex:2,endIndex:2,fraction:0}}])).toMatchObject([{startIndex:2,endIndex:2,fraction:0}])
    for(const anchor of [{startIndex:0,endIndex:2,fraction:.5},{startIndex:4,endIndex:4,fraction:0},{startIndex:0,endIndex:1,fraction:NaN}]) {
      expect(projectProfilePlacemarks(points,[{...marker('bad',.001,0),routePosition:anchor}])).toMatchObject([{startIndex:0,endIndex:1,fraction:.5}])
    }
  })
  it('never projects onto a bridge between explicitly separate source lines',()=>{
    const points=[point(0,0),point(.001,0),point(.003,0),point(.004,0)]
    const mark={...marker('gap',.002,0),routePosition:{startIndex:1,endIndex:2,fraction:.5}}
    expect(projectProfilePlacemarks(points,[mark],[0,2])).toMatchObject([{startIndex:0,endIndex:1,fraction:1}])
  })
})
