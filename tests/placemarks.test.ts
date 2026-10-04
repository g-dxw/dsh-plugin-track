// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { parseTrackFile } from '../src/track/import.ts'
import { parseKmlPlacemarks, validatePlacemarks } from '../src/track/placemarks.ts'
import { loadTrackPlacemarks } from '../src/client/useTrackPlacemarks.ts'
import { annotationsFromPlacemarks, trackSvg, validateAnnotations } from '../src/track/annotations.ts'
import type { TrackRecord } from '../src/protocol.ts'

export const KML_POINTS=`<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>路线</name><LineString><coordinates>119,30,100 119.01,30.01,200 119.02,30,150</coordinates></LineString></Placemark>
  <Placemark><name>牧场</name><description><![CDATA[草地 <img src="https://example.com/one.jpg"><img src="https://example.com/two.jpg"><img src="javascript:alert(1)"><script>bad()</script>]]></description><Point><coordinates>119.01,30.01,200</coordinates></Point></Placemark>
  <Placemark><name>补水点</name><Point><coordinates>119.01001,30.01001</coordinates></Point></Placemark>
</Document></kml>`
afterEach(()=>vi.unstubAllGlobals())
describe('KML point metadata remains independent from path measurements',()=>{
  it('keeps locations and multiple image links without adding them to the measured track',()=>{
    const parsed=parseTrackFile('路线.kml',KML_POINTS)
    expect(parsed.points).toHaveLength(3);expect(parsed.placemarks).toHaveLength(2)
    expect(parsed.placemarks![0]).toMatchObject({name:'牧场',coordinates:[119.01,30.01],description:'草地',images:['https://example.com/one.jpg','https://example.com/two.jpg'],elevation:200,time:null})
    expect(parsed.metrics.distance).toBe(parseTrackFile('路线.kml',KML_POINTS.replace(/<Placemark><name>牧场[\s\S]*?<\/Placemark>/u,'')).metrics.distance)
  })
  it('supports prefixed KML XML and filters invalid coordinates and executable links',()=>{
    const source='<k:kml xmlns:k="http://www.opengis.net/kml/2.2"><k:Placemark><k:name>点位</k:name><k:description><![CDATA[<img src="file:///secret"><img src="https://example.com/image?id=1">]]></k:description><k:Point><k:coordinates>120,30</k:coordinates></k:Point></k:Placemark><k:Placemark><k:Point><k:coordinates>999,30</k:coordinates></k:Point></k:Placemark></k:kml>'
    expect(parseKmlPlacemarks(source)).toEqual([{id:'kml-1',name:'点位',coordinates:[120,30],description:'',images:['https://example.com/image?id=1'],elevation:null,time:null}])
    expect(()=>validatePlacemarks([{id:'kml-1',name:'点位',coordinates:[120,30],description:'',images:['javascript:alert(1)']}])).toThrow()
  })
  it('preserves two locations near the same path sample, their source coordinates, and saved layout',()=>{
    const parsed=parseTrackFile('路线.kml',KML_POINTS),points=parsed.points
    const annotations=annotationsFromPlacemarks(parsed.placemarks!,points)
    expect(annotations[0].pointIndex).toBe(annotations[1].pointIndex)
    const saved=validateAnnotations([{...annotations[0],visible:true,position:{x:300,y:400}},{...annotations[1],position:{x:330,y:440}}],points.length)
    expect(saved[0].sourceCoordinates).toEqual([119.01,30.01]);expect(saved[0].imageUrls).toHaveLength(2)
    expect(trackSvg(points,{name:'路线',annotations:saved})).toContain('cx="300.00" cy="400.00"')
  })
  it('recovers old saved KML locations from the unchanged original source only when metadata is absent',async()=>{
    const track={id:'old',format:'kml'} as TrackRecord
    const fetch=vi.fn().mockResolvedValue(new Response(KML_POINTS));vi.stubGlobal('fetch',fetch)
    expect(await loadTrackPlacemarks(track)).toHaveLength(2);expect(fetch).toHaveBeenCalledWith('/api/cqai-track/source?id=old',{signal:undefined})
    expect(await loadTrackPlacemarks({...track,placemarks:[]})).toEqual([]);expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('keeps an unnamed photo point and its own prefixed elevation and timestamp',()=>{
    const source='<k:kml xmlns:k="http://www.opengis.net/kml/2.2"><k:Placemark><k:name><![CDATA[ ]]></k:name><k:description><![CDATA[<img src="https://example.com/photo.jpg">]]></k:description><k:TimeStamp><k:when>2026-05-29T06:48:22Z</k:when></k:TimeStamp><k:Point><k:coordinates>120,30,501.59</k:coordinates></k:Point></k:Placemark></k:kml>'
    expect(parseKmlPlacemarks(source)).toEqual([{id:'kml-1',name:'',coordinates:[120,30],description:'',images:['https://example.com/photo.jpg'],elevation:501.59,time:Date.parse('2026-05-29T06:48:22Z')}])
  })
  it('does not inherit document, folder or nested metadata timestamps',()=>{
    const source='<kml><Document><TimeStamp><when>2026-05-29T00:00:00Z</when></TimeStamp><Folder><TimeStamp><when>2026-05-29T01:00:00Z</when></TimeStamp><Placemark><ExtendedData><TimeStamp><when>2026-05-29T02:00:00Z</when></TimeStamp><Data name="Time"><value>1780037302000</value></Data></ExtendedData><Point><coordinates>120,30</coordinates></Point></Placemark></Folder></Document></kml>'
    expect(parseKmlPlacemarks(source)[0]).toMatchObject({name:'',elevation:null,time:null})
  })
  it('preserves sea-level altitude and epoch-zero time',()=>{
    const source='<kml><Placemark><TimeStamp><when>1970-01-01T00:00:00Z</when></TimeStamp><Point><coordinates>120,30,0</coordinates></Point></Placemark></kml>'
    expect(parseKmlPlacemarks(source)[0]).toMatchObject({elevation:0,time:0})
  })
  it.each(['', 'bad', 'Infinity'])('does not turn missing or invalid altitude %s into sea level',altitude=>{
    const source=`<kml><Placemark><TimeStamp><when>invalid</when></TimeStamp><Point><coordinates>120,30,${altitude}</coordinates></Point></Placemark></kml>`
    expect(parseKmlPlacemarks(source)[0]).toMatchObject({elevation:null,time:null})
  })
  it('allows empty names and preserves valid optional metadata while accepting old records',()=>{
    const point={id:'kml-1',name:' ',coordinates:[120,30],description:'',images:[]}
    expect(validatePlacemarks([point])).toEqual([{...point,name:''}])
    expect(validatePlacemarks([{...point,elevation:-12.5,time:0}])[0]).toMatchObject({name:'',elevation:-12.5,time:0})
    expect(validatePlacemarks([{...point,elevation:null,time:null}])[0]).toMatchObject({elevation:null,time:null})
  })
  it.each([
    {elevation:'501.59'}, {elevation:Number.NaN}, {elevation:Number.POSITIVE_INFINITY},
    {time:'2026-05-29T06:48:22Z'}, {time:Number.NaN}, {time:Number.POSITIVE_INFINITY}, {time:1e30},
  ])('rejects invalid point metadata %j',metadata=>{
    expect(()=>validatePlacemarks([{id:'kml-1',name:'',coordinates:[120,30],description:'',images:[],...metadata}])).toThrow(/海拔无效|时间无效/u)
  })
})
