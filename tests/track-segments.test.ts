// @vitest-environment jsdom
import {describe,expect,it} from 'vitest'
import {flattenGeoJSON} from '../src/track/geometry.ts'
import {parseTrackFile} from '../src/track/import.ts'
import {toGeoJSON} from '../src/track/trail-layer.ts'
import {derivePlacemarkLocation} from '../src/track/placemark-location.ts'
import type {TrackPoint} from '../src/protocol.ts'

const feature=(type:string,coordinates:unknown,times?:unknown)=>({type:'Feature',geometry:{type,coordinates},properties:{coordinateProperties:{times}}})
const sample=(lon:number):TrackPoint=>[lon,0,null,null]

describe('source path boundaries survive flattening',()=>{
  it('retains separate features, nested line branches, and timestamp slots after bad fixes',()=>{
    const source={type:'FeatureCollection',features:[
      feature('LineString',[[0,0],[.001,0]]),
      feature('Point',[.001,0]),
      feature('MultiLineString',[[[.002,0],[NaN,0],[.003,0]],[],[[.004,0],[.005,0]]],[[1000,2000,3000],[],[4000,5000]]),
    ]}
    const flat=flattenGeoJSON(source)
    expect(flat.points.map(point=>point[0])).toEqual([0,.001,.002,.003,.004,.005])
    expect(flat.segmentStarts).toEqual([0,2,3,4])
    expect(flat.points.map(point=>point[3])).toEqual([null,null,1000,3000,4000,5000])
  })
  it('breaks at invalid geographic coordinates and separates polygon rings',()=>{
    const flat=flattenGeoJSON({type:'GeometryCollection',geometries:[
      {type:'LineString',coordinates:[[0,0],[181,0],[null,0],[false,0],[.001,0],[0,91],[.002,0]]},
      {type:'Polygon',coordinates:[[[1,0],[1.001,0]],[[2,0],[2.001,0]]]},
    ]})
    expect(flat.segmentStarts).toEqual([0,1,2,3,5])
    expect(flat.points).toHaveLength(7)
    expect(flattenGeoJSON({type:'LineString',coordinates:[]}).segmentStarts).toEqual([])
  })
  it('preserves GPX track/segment boundaries and breaks after unusable fixes',()=>{
    const xml=`<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
      <trkpt lon="0" lat="0"/><trkpt lon="0.001" lat="0"/><trkpt lon="181" lat="0"/><trkpt/><trkpt lat="0"/><trkpt lon="0.002" lat="0"/>
      </trkseg><trkseg/><trkseg><trkpt lon="0.003" lat="0"/><trkpt lon="0.004" lat="0"/></trkseg></trk>
      <trk><trkseg><trkpt lon="0.005" lat="0"/></trkseg></trk></gpx>`
    const parsed=parseTrackFile('parts.gpx',xml)
    expect(parsed.points.map(point=>point[0])).toEqual([0,.001,.002,.003,.004,.005])
    expect(parsed.segmentStarts).toEqual([0,2,3,5])
  })
  it('retains KML MultiGeometry lines independently of annotation points',()=>{
    const xml=`<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><Point><coordinates>1,0,20</coordinates></Point></Placemark>
      <Placemark><MultiGeometry><LineString><coordinates>0,0,100 0.001,0,200</coordinates></LineString>
      <LineString><coordinates>0.003,0,300 0.004,0,400</coordinates></LineString></MultiGeometry></Placemark></Document></kml>`
    const parsed=parseTrackFile('parts.kml',xml)
    expect(parsed.segmentStarts).toEqual([0,2])
    expect(parsed.placemarks).toHaveLength(1)
    expect(()=>derivePlacemarkLocation(parsed.points,{segmentStarts:parsed.segmentStarts,references:parsed.placemarks!},{startIndex:1,endIndex:2,fraction:.5})).toThrow(/分段/u)
  })
  it('retains TCX Track boundaries in the same Lap',()=>{
    const xml=`<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Hiking"><Id>2026-01-01T00:00:00Z</Id><Lap StartTime="2026-01-01T00:00:00Z">
      <Track><Trackpoint><Position><LatitudeDegrees>0</LatitudeDegrees><LongitudeDegrees>0</LongitudeDegrees></Position></Trackpoint><Trackpoint><Position><LatitudeDegrees>0</LatitudeDegrees><LongitudeDegrees>0.001</LongitudeDegrees></Position></Trackpoint></Track>
      <Track><Trackpoint><Position><LatitudeDegrees>0</LatitudeDegrees><LongitudeDegrees>0.003</LongitudeDegrees></Position></Trackpoint><Trackpoint><Position><LatitudeDegrees>0</LatitudeDegrees><LongitudeDegrees>0.004</LongitudeDegrees></Position></Trackpoint></Track>
      </Lap></Activity></Activities></TrainingCenterDatabase>`
    const parsed=parseTrackFile('parts.tcx',xml)
    expect(parsed.segmentStarts).toEqual([0,2])
    expect(parsed.points.map(point=>point[0])).toEqual([0,.001,.003,.004])
  })
})

describe('segmented map data',()=>{
  it('keeps old one-argument output, and creates separate lines when boundaries are supplied',()=>{
    const points=[sample(0),sample(.001),sample(.003),sample(.004)]
    expect(toGeoJSON(points).line.geometry).toEqual({type:'LineString',coordinates:[[0,0],[.001,0],[.003,0],[.004,0]]})
    expect(toGeoJSON(points,[0,2]).line.geometry).toEqual({type:'MultiLineString',coordinates:[[[0,0],[.001,0]],[[.003,0],[.004,0]]]})
    expect(toGeoJSON(points,[0,2]).ends.features.map(point=>point.geometry.coordinates)).toEqual([[0,0],[.004,0]])
  })
  it('keeps per-line timestamps aligned including epoch zero and invalid fixes',()=>{
    const points:TrackPoint[]=[[0,0,10,0],[.001,0,20,1000],[NaN,0,null,null],[.003,0,null,2000]]
    const result=toGeoJSON(points,[0])
    expect(result.line.geometry).toEqual({type:'MultiLineString',coordinates:[[[0,0,10],[.001,0,20]],[[.003,0]]]})
    expect(result.line.properties?.coordinateProperties.times).toEqual([[new Date(0).toISOString(),new Date(1000).toISOString()],[new Date(2000).toISOString()]])
  })
  it('keeps a single run as LineString and skips empty/bad parts without bridges',()=>{
    expect(toGeoJSON([sample(0),sample(.001)],[0]).line.geometry.type).toBe('LineString')
    expect(toGeoJSON([],[]).line.geometry).toEqual({type:'LineString',coordinates:[]})
    expect(toGeoJSON([sample(0),sample(181),sample(.002)],[0]).line.geometry).toEqual({type:'MultiLineString',coordinates:[[[0,0]],[[.002,0]]]})
  })
})
