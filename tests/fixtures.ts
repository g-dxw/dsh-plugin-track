/**
 * Track files the tests parse, written by hand rather than copied from a
 * device.
 *
 * They are hand-written on purpose: upstream's parser has a few behaviours that
 * only make sense against a file deliberately built to expose them (a missing
 * `<ele>` that must stay missing, a route that is not a track, a `Trackpoint`
 * list too short for `toGeoJSON` to call a line), and a real recording from a
 * watch would put a fixed, unexplained number of points behind every assertion.
 *
 * Coordinates are round on purpose — 30°N / 120°E and multiples of 0.01° — so
 * the expected distance is arithmetic the reader can check by hand.
 */

/** A three-point GPX with elevation and time, a metadata name, and a waypoint. */
export const GPX_TRACK = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="cqai-track-test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>测试环线</name></metadata>
  <wpt lat="30.0005" lon="120.0005"><name>补给点</name></wpt>
  <trk>
    <name>晨跑</name>
    <trkseg>
      <trkpt lat="30" lon="120"><ele>100</ele><time>2026-09-20T01:00:00Z</time></trkpt>
      <trkpt lat="30" lon="120.01"><ele>120</ele><time>2026-09-20T01:10:00Z</time></trkpt>
      <trkpt lat="30" lon="120.02"><ele>110</ele><time>2026-09-20T01:20:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`

/**
 * The same shape with no `<ele>` and no `<time>` anywhere, which is what a
 * phone's location-only recording looks like. Elevation must come back `null`
 * for these, never `0`: a flat sea-level profile is a lie about a real walk.
 */
export const GPX_NO_ELEVATION = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="cqai-track-test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>无海拔</name><trkseg>
    <trkpt lat="30" lon="120"/>
    <trkpt lat="30" lon="120.01"/>
    <trkpt lat="30" lon="120.02"/>
  </trkseg></trk>
</gpx>`

/** Route only — a planned path, no recorded track. */
export const GPX_ROUTE_ONLY = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="cqai-track-test" xmlns="http://www.topografix.com/GPX/1/1">
  <rte>
    <name>规划路线</name>
    <rtept lat="30" lon="120"/>
    <rtept lat="30" lon="120.01"/>
  </rte>
</gpx>`

/** A GPX that parses but has nothing to draw — the panel's "no points" path. */
export const GPX_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="cqai-track-test"><metadata><name>空的</name></metadata></gpx>`

/** Truncated mid-element: not a GPX file, and the reader has to say so. */
export const GPX_UNTERMINATED = `<gpx version="1.1"><trk><trkseg><trkpt lat="30" lon="120">`

/** Well-formed XML that is not GPX at all. */
export const NOT_GPX = `<foo><bar>30</bar></foo>`

/** A KML `LineString` under a named `Placemark`; KML carries no times. */
export const KML_TRACK = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>测试路线</name>
      <LineString>
        <coordinates>
          120,30,100
          120.01,30,120
          120.02,30,110
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`

/** A named waypoint precedes the route, as in hiking KML exports. */
export const KML_WAYPOINT_FIRST = KML_TRACK.replace('<Document>', `<Document>
  <Placemark><name>起点</name><Point><coordinates>120,30,100</coordinates></Point></Placemark>`)

/** A Garmin TCX activity: one `Lap` holding one `Track` of three points. */
export const TCX_TRACK = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>2026-09-20T01:00:00Z</Id>
      <Lap StartTime="2026-09-20T01:00:00Z">
        <TotalTimeSeconds>1200</TotalTimeSeconds>
        <DistanceMeters>2224</DistanceMeters>
        <Track>
          <Trackpoint>
            <Time>2026-09-20T01:00:00Z</Time>
            <Position><LatitudeDegrees>30</LatitudeDegrees><LongitudeDegrees>120</LongitudeDegrees></Position>
            <AltitudeMeters>100</AltitudeMeters>
          </Trackpoint>
          <Trackpoint>
            <Time>2026-09-20T01:10:00Z</Time>
            <Position><LatitudeDegrees>30</LatitudeDegrees><LongitudeDegrees>120.01</LongitudeDegrees></Position>
            <AltitudeMeters>120</AltitudeMeters>
          </Trackpoint>
          <Trackpoint>
            <Time>2026-09-20T01:20:00Z</Time>
            <Position><LatitudeDegrees>30</LatitudeDegrees><LongitudeDegrees>120.02</LongitudeDegrees></Position>
            <AltitudeMeters>110</AltitudeMeters>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`

/** A `Lap` with a single `Trackpoint`: the vendor reader drops it, not us. */
export const TCX_SINGLE_POINT = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities><Activity Sport="Running"><Lap StartTime="2026-09-20T01:00:00Z">
    <Track><Trackpoint>
      <Time>2026-09-20T01:00:00Z</Time>
      <Position><LatitudeDegrees>30</LatitudeDegrees><LongitudeDegrees>120</LongitudeDegrees></Position>
    </Trackpoint></Track>
  </Lap></Activity></Activities>
</TrainingCenterDatabase>`

/** Epoch milliseconds of the timestamps above, so the tests read as arithmetic. */
export const T0 = Date.parse('2026-09-20T01:00:00Z')
export const MINUTE = 60_000
/** The fixtures advance ten minutes between points, not one. */
export const STEP = 10 * MINUTE

/**
 * One 0.01° step east at 30°N — the length of every leg in the fixtures above.
 * Independent of `haversineDistance` so a change to that function cannot make
 * its own test pass. Note the latitude: a degree of longitude is 111.19 km at
 * the equator and 96.30 km at 30°N, and using the equatorial figure here would
 * quietly assert the wrong distance.
 */
export const LEG_METRES = 962.9763121562811

/** Three measured legs' surface length, including their actual height changes. */
export const SURFACE_METRES = Math.hypot(LEG_METRES, 20) + Math.hypot(LEG_METRES, 10)

/** Exporter stores a route summary, with untimed coordinates and unrelated photo time. */
export const KML_SUMMARY = KML_TRACK.replace('<Document>', `<Document>
  <ExtendedData>
    <Data name="TimeUsed"><value>45222000</value></Data>
    <Data name="BeginTime"><value>1780037302000</value></Data>
    <Data name="EndTime"><value>1780082524000</value></Data>
  </ExtendedData>
  <Placemark><TimeStamp><when>2026-05-30T23:00:00Z</when></TimeStamp><Point><coordinates>121,31</coordinates></Point></Placemark>`)
