/**
 * The waypoint shape the elevation profile draws markers for.
 *
 * Upstream imported `$lib/models/waypoint` — wanderer's *app-level* waypoint, a
 * community marker carrying a name, an icon and a distance along the trail. It
 * is a different type from the GPX model's `Waypoint`, which has no `icon` and
 * keeps its coordinates under `$`; pointing the ported import at the GPX class
 * would be a type error and, worse, a lie about what the profile consumes.
 *
 * This is that shape reduced to the members `elevationprofile.ts` actually
 * touches. The rest of wanderer's version (marker, photos, author, trail) hangs
 * off its trail pages, which have no counterpart here.
 *
 * Nothing constructs one today: the panel calls `setData(geojson)` with the
 * waypoint argument omitted, so the marker path never runs. The type exists so
 * the ported code keeps its own vocabulary instead of growing an `any`.
 */
export interface Waypoint {
  name?: string
  icon?: string
  lat: number
  lon: number
  distance_from_start?: number
}
