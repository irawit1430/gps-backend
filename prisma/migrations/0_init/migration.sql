-- Baseline migration for Voltava Fleet Postgres schema.
-- Generated to mirror prisma/schema.postgresql.prisma.

-- ─── Enums ──────────────────────────────────────────────────────────────
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'SCHOOL_ADMIN', 'DRIVER', 'PARENT');
CREATE TYPE "TripStatus" AS ENUM ('PLANNED', 'ON_SCHEDULE', 'DELAYED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "AttendanceType" AS ENUM ('BOARDED', 'ALIGHTED');
CREATE TYPE "EmergencyType" AS ENUM ('DRIVER_SOS', 'HARDWARE_SOS', 'ADMIN_BROADCAST', 'DELAY');
CREATE TYPE "EmergencyStatus" AS ENUM ('ACTIVE', 'RESOLVED');
CREATE TYPE "NotificationType" AS ENUM ('ARRIVAL', 'BOARDING', 'DELAY', 'SYSTEM', 'LEAVE', 'SOS');

-- ─── Tables ─────────────────────────────────────────────────────────────
CREATE TABLE "School" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "contactPerson" TEXT,
    "city" TEXT,
    "state" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "School_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "name" TEXT NOT NULL,
    "photoUrl" TEXT,
    "notificationSettings" JSONB,
    "mustResetPassword" BOOLEAN NOT NULL DEFAULT false,
    "schoolId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_schoolId_idx" ON "User"("schoolId");
CREATE INDEX "User_role_idx" ON "User"("role");

CREATE TABLE "Bus" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT,
    "licensePlate" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Bus_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Bus_licensePlate_key" ON "Bus"("licensePlate");
CREATE UNIQUE INDEX "Bus_deviceId_key" ON "Bus"("deviceId");
CREATE INDEX "Bus_schoolId_idx" ON "Bus"("schoolId");

CREATE TABLE "Route" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "estimatedDuration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Route_schoolId_idx" ON "Route"("schoolId");

CREATE TABLE "RouteStop" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "orderIdx" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RouteStop_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RouteStop_routeId_orderIdx_idx" ON "RouteStop"("routeId", "orderIdx");

CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "rfidTag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "grade" TEXT,
    "photoUrl" TEXT,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Student_rfidTag_key" ON "Student"("rfidTag");
CREATE INDEX "Student_schoolId_idx" ON "Student"("schoolId");
CREATE INDEX "Student_parentId_idx" ON "Student"("parentId");

CREATE TABLE "StudentRouteMapping" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "routeStopId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StudentRouteMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StudentRouteMapping_studentId_routeStopId_key" ON "StudentRouteMapping"("studentId", "routeStopId");
CREATE INDEX "StudentRouteMapping_routeStopId_idx" ON "StudentRouteMapping"("routeStopId");

CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'PLANNED',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "currentEtaMessage" TEXT,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Trip_driverId_status_idx" ON "Trip"("driverId", "status");
CREATE INDEX "Trip_busId_status_idx" ON "Trip"("busId", "status");
CREATE INDEX "Trip_routeId_status_idx" ON "Trip"("routeId", "status");

CREATE TABLE "GpsLog" (
    "id" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "tripId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GpsLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GpsLog_busId_timestamp_idx" ON "GpsLog"("busId", "timestamp" DESC);
CREATE INDEX "GpsLog_timestamp_idx" ON "GpsLog"("timestamp");

CREATE TABLE "AttendanceLog" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "type" "AttendanceType" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AttendanceLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AttendanceLog_studentId_timestamp_idx" ON "AttendanceLog"("studentId", "timestamp");
CREATE INDEX "AttendanceLog_tripId_timestamp_idx" ON "AttendanceLog"("tripId", "timestamp");

CREATE TABLE "LeaveApplication" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LeaveApplication_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LeaveApplication_studentId_status_idx" ON "LeaveApplication"("studentId", "status");
CREATE INDEX "LeaveApplication_status_createdAt_idx" ON "LeaveApplication"("status", "createdAt" DESC);

CREATE TABLE "EmergencyAlert" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "type" "EmergencyType" NOT NULL,
    "message" TEXT,
    "senderId" TEXT,
    "tripId" TEXT,
    "status" "EmergencyStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmergencyAlert_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmergencyAlert_schoolId_status_idx" ON "EmergencyAlert"("schoolId", "status");
CREATE INDEX "EmergencyAlert_createdAt_idx" ON "EmergencyAlert"("createdAt" DESC);

CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'SYSTEM',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");

CREATE TABLE "GlobalSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "maintenanceMode" BOOLEAN NOT NULL DEFAULT false,
    "mapCenterLat" DOUBLE PRECISION NOT NULL DEFAULT 28.7041,
    "mapCenterLng" DOUBLE PRECISION NOT NULL DEFAULT 77.1025,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GlobalSettings_pkey" PRIMARY KEY ("id")
);

-- ─── Foreign Keys ───────────────────────────────────────────────────────
ALTER TABLE "User" ADD CONSTRAINT "User_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Bus" ADD CONSTRAINT "Bus_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Route" ADD CONSTRAINT "Route_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Student" ADD CONSTRAINT "Student_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Student" ADD CONSTRAINT "Student_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StudentRouteMapping" ADD CONSTRAINT "StudentRouteMapping_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentRouteMapping" ADD CONSTRAINT "StudentRouteMapping_routeStopId_fkey" FOREIGN KEY ("routeStopId") REFERENCES "RouteStop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Trip" ADD CONSTRAINT "Trip_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_busId_fkey" FOREIGN KEY ("busId") REFERENCES "Bus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GpsLog" ADD CONSTRAINT "GpsLog_busId_fkey" FOREIGN KEY ("busId") REFERENCES "Bus"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GpsLog" ADD CONSTRAINT "GpsLog_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AttendanceLog" ADD CONSTRAINT "AttendanceLog_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendanceLog" ADD CONSTRAINT "AttendanceLog_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveApplication" ADD CONSTRAINT "LeaveApplication_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
