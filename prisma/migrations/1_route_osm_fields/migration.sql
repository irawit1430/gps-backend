-- Route: add distance + polyline geometry (OSRM-produced)
ALTER TABLE "Route" ADD COLUMN "distanceKm" DOUBLE PRECISION;
ALTER TABLE "Route" ADD COLUMN "geometry"   TEXT;

-- RouteStop: add human-readable address + expected arrival offset
ALTER TABLE "RouteStop" ADD COLUMN "address"                TEXT;
ALTER TABLE "RouteStop" ADD COLUMN "expectedArrivalMinutes" INTEGER;
