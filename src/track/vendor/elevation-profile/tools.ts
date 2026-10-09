import { haversineDistance } from "../../model/utils";
import type {
    Position
} from "geojson";


export function haversineCumulatedDistanceWgs84(path: Position[]): number[] {
    if (path.length < 2) {
        return [];
    }

    let totalDistance = 0;
    const distances: number[] = [0];

    for (let i = 0; i < path.length - 1; i++) {
        const [lon1, lat1] = path[i];
        const [lon2, lat2] = path[i + 1];

        totalDistance += haversineDistance(lat1, lon1, lat2, lon2);
        distances.push(totalDistance);
    }

    return distances; // Array of cumulative distances in meters
}

export function smoothElevations(positions: Position[], windowSize: number): Position[] {
    // Ensure windowSize is valid (at least 1)
    if (windowSize < 1) {
        console.warn("Window size must be at least 1.");
        return positions
    };

    // Create a new array with smoothed elevations
    return positions.map((pos, i, arr) => {
        // A hand-drawn or moved point has no measured altitude. Keep a real gap,
        // and do not let it poison neighbouring samples or bridge two recordings.
        if (!Number.isFinite(pos[2])) return [pos[0], pos[1]] as Position;
        let start = Math.max(0, i - Math.floor(windowSize / 2));
        let end = Math.min(arr.length, i + Math.floor(windowSize / 2) + 1);
        for (let j = i - 1; j >= start; j--) if (!Number.isFinite(arr[j][2])) { start = j + 1; break; }
        for (let j = i + 1; j < end; j++) if (!Number.isFinite(arr[j][2])) { end = j; break; }
        const segment = arr.slice(start, end);

        // Calculate the weighted moving average of elevations
        const weights = segment.map((_, idx) => idx + 1); // Increasing weights: 1, 2, 3...
        const elevations = segment.map(p => p[2]); // Extract elevations
        const weightedSum = elevations.reduce((sum, elevation, idx) => sum + elevation * weights[idx], 0);
        const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

        const smoothedElevation = weightedSum / weightTotal; // Weighted average elevation

        // Return a new Position with the smoothed elevation
        return [pos[0], pos[1], smoothedElevation] as Position;
    });
}