import Metadata from './metadata';
import Route from './route';
import Track from './track';
import { removeEmpty } from './utils';
import Waypoint from './waypoint';
import GpxMetricsComputation from './gpx-metrics-computation';
import { bbox } from './bbox';
import { parseGpxXml, type GpxObject } from './gpx-xml';

const defaultAttributes = {
  version: '1.1',
  creator: 'wanderer',
  xmlns: 'http://www.topografix.com/GPX/1/1',
  'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
  'xsi:schemaLocation':
    'http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd'
}


type GPXFeature = {
  centroid: { lat: number; lon: number };
  boundingBox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  distance: number;
  cumulativeDistance: number[]
  elevationGain?: number;
  elevationLoss?: number;
  duration: number;
};

export default class GPX {
  $: {
    version: string;
    creator: string;
    xmlns: string;
    'xmlns:xsi': string;
    'xsi:schemaLocation': string;
  }
  extensions?: string;
  metadata?: Metadata;
  wpt?: Waypoint[];
  rte?: Route[];
  trk?: Track[];
  features: GPXFeature

  constructor(object: {
    $?: {
      version: string,
      creator: string,
      xmlns: string,
      'xmlns:xsi': string,
      'xsi:schemaLocation': string,
    }
    extensions?: string,
    metadata?: Metadata,
    wpt?: Waypoint[] | Waypoint,
    rte?: Route[] | Route,
    trk?: Track[],
  }) {
    this.$ = Object.assign({}, defaultAttributes, object.$ || {});
    if (object.extensions) {
      this.extensions = object.extensions;
    }

    if (object.metadata) {
      this.metadata = object.metadata;
    }
    if (object.wpt) {
      if (!Array.isArray(object.wpt)) {
        object.wpt = [object.wpt];
      }
      this.wpt = object.wpt.filter(trk => typeof trk === 'object').map(wpt => new Waypoint(wpt))
    }
    if (object.rte) {
      if (!Array.isArray(object.rte)) {
        object.rte = [object.rte];
      }
      this.rte = object.rte.filter(trk => typeof trk === 'object').map(rte => new Route(rte))
    }
    if (object.trk) {
      if (!Array.isArray(object.trk)) {
        object.trk = [object.trk];
      }
      this.trk = object.trk.filter(trk => typeof trk === 'object').map(trk => new Track(trk))
    }

    this.features = this.getTotals();

    removeEmpty(this);
  }

  getTotals(): GPXFeature {
    let totalElevationGain = 0;
    let totalElevationLoss = 0;
    let totalDuration = 0;
    let totalDistance = 0;
    let totalLat = 0
    let totalLon = 0

    const metrics = new GpxMetricsComputation(5, 5);

    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

    const allPoints: Waypoint[] = []
    for (const track of this.trk ?? []) {
      for (const segment of track.trkseg ?? []) {
        const points = segment.trkpt ?? [];
        allPoints.push(...points);

        if (points.length >= 2) {
          const startTime = points[0].time;
          const endTime = points[points.length - 1].time

          if (startTime && endTime) {
            totalDuration += endTime.getTime() - startTime.getTime();
          }
        }

        const pointLength = points.length
        for (let i = 1; i < pointLength; i++) {
          const point = points[i];
          metrics.addAndFilter(point)

          totalLat += point.$.lat ?? 0;
          totalLon += point.$.lon ?? 0;

          minLat = Math.min(minLat, point.$.lat ?? Infinity);
          maxLat = Math.max(maxLat, point.$.lat ?? -Infinity);
          minLon = Math.min(minLon, point.$.lon ?? Infinity);
          maxLon = Math.max(maxLon, point.$.lon ?? -Infinity);
        }
      }
    }

    totalElevationGain = metrics.totalElevationGainSmoothed;
    totalElevationLoss = metrics.totalElevationLossSmoothed;
    totalDistance = metrics.totalDistance;

    const boundingBox = { minLat, maxLat, minLon, maxLon };
    const centroid = { lat: totalLat / allPoints.length, lon: totalLon / allPoints.length };

    return {
      centroid,
      boundingBox,
      distance: totalDistance,
      cumulativeDistance: metrics.cumulativeDistance,
      elevationGain: totalElevationGain,
      elevationLoss: totalElevationLoss,
      duration: Math.abs(totalDuration),
    }
  }

  flatten() {
    const points: Waypoint[] = [];

    this.trk?.forEach(track => {
      track.trkseg?.forEach(segment => {
        segment.trkpt?.forEach(pt => {
          points.push(pt);
        });
      });
    });

    return points;
  }

  /**
   * Parse a GPX document string.
   *
   * Upstream fed `isomorphic-xml2js` into the constructor; we hand the same
   * plain-object shape in from a native `DOMParser` reader instead, so the model
   * classes stay exactly as they were.
   */
  static parse(gpxString: string): GPX {
    return GPX.fromObject(parseGpxXml(gpxString));
  }

  /**
   * Build from the plain-object tree a GPX DOM read produces.
   *
   * The constructor merges `object.$` over `defaultAttributes`, so a document
   * carrying no `<gpx>` attributes at all is fine — the declared attribute type
   * on the field describes the merged result, not what a file has to supply.
   */
  static fromObject(object: GpxObject): GPX {
    return new GPX({
      $: object.$ as typeof defaultAttributes,
      metadata: object.metadata,
      wpt: object.wpt,
      rte: object.rte,
      trk: object.trk
    });
  }

  toGeoJSON(includeRoute: boolean = false, includeWaypoints: boolean = false): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];

    if (this.wpt && includeWaypoints) {
      for (const wpt of this.wpt) {
        features.push(wpt.toGeoJSON());
      }
    }

    if (this.rte && includeRoute) {
      for (const rte of this.rte) {
        features.push(rte.toGeoJSON());
      }
    }

    if (this.trk) {
      for (const trk of this.trk) {
        features.push(...trk.toGeoJSON());
      }
    }

    let geojson: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features
    };

    geojson.bbox = bbox(geojson)

    return geojson
  }
}
