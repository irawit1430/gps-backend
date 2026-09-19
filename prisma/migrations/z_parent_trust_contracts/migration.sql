ALTER TYPE "LeaveStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "School"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN "supportHours" TEXT,
  ADD COLUMN "leaveCutoffMinutes" INTEGER,
  ADD COLUMN "leaveResponseHours" INTEGER;

ALTER TABLE "AttendanceLog"
  ADD COLUMN "stopId" TEXT,
  ADD COLUMN "stopName" TEXT,
  ADD COLUMN "lat" DOUBLE PRECISION,
  ADD COLUMN "lng" DOUBLE PRECISION,
  ADD COLUMN "recordedBy" TEXT,
  ADD COLUMN "handoverConfirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "evidenceAt" TIMESTAMP(3),
  ADD COLUMN "distanceFromStopMeters" DOUBLE PRECISION,
  ADD COLUMN "evidenceStatus" TEXT,
  ADD COLUMN "requestKey" TEXT;

ALTER TABLE "LeaveApplication"
  ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'SCHOOL',
  ADD COLUMN "direction" "RunDirection",
  ADD COLUMN "startDay" TEXT,
  ADD COLUMN "endDay" TEXT,
  ADD COLUMN "timezone" TEXT,
  ADD COLUMN "requestKey" TEXT,
  ADD COLUMN "requestHash" TEXT,
  ADD COLUMN "decisionReason" TEXT,
  ADD COLUMN "decidedBy" TEXT,
  ADD COLUMN "decidedAt" TIMESTAMP(3),
  ADD COLUMN "cancellationRequestedAt" TIMESTAMP(3),
  ADD COLUMN "history" JSONB;

UPDATE "LeaveApplication" l
SET "timezone" = COALESCE(s."timezone", 'Asia/Kolkata'),
    -- Prisma stored these UTC instants in TIMESTAMP WITHOUT TIME ZONE columns.
    -- Attach UTC first, then render the instant in the school's timezone.
    "startDay" = TO_CHAR((l."startDate" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(s."timezone", 'Asia/Kolkata'), 'YYYY-MM-DD'),
    "endDay" = TO_CHAR((l."endDate" AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(s."timezone", 'Asia/Kolkata'), 'YYYY-MM-DD'),
    "history" = jsonb_build_array(jsonb_build_object('action', 'MIGRATED', 'at', CURRENT_TIMESTAMP))
FROM "Student" st
JOIN "School" s ON s."id" = st."schoolId"
WHERE st."id" = l."studentId";

ALTER TABLE "EmergencyAlert"
  ADD COLUMN "resolvedBy" TEXT,
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolutionNote" TEXT,
  ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'ALL';

ALTER TABLE "Notification"
  ADD COLUMN "context" JSONB,
  ADD COLUMN "eventKey" TEXT;

CREATE TABLE "PushDevice" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'FCM',
  "token" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastAcceptedAt" TIMESTAMP(3),
  "lastFailure" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PushDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "IncidentAcknowledgement" (
  "id" TEXT NOT NULL,
  "alertId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "alertUpdatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IncidentAcknowledgement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IncidentAcknowledgement_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "EmergencyAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IncidentAcknowledgement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "StopEvent" (
  "id" TEXT NOT NULL,
  "tripId" TEXT NOT NULL,
  "stopId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "recordedBy" TEXT NOT NULL,
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "requestKey" TEXT NOT NULL,
  CONSTRAINT "StopEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StopEvent_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AccountRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "schoolId" TEXT,
  "type" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "decisionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AccountRequest_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AttendanceLog_requestKey_key" ON "AttendanceLog"("requestKey");
CREATE UNIQUE INDEX "LeaveApplication_requestKey_key" ON "LeaveApplication"("requestKey");
CREATE UNIQUE INDEX "Notification_eventKey_key" ON "Notification"("eventKey");
CREATE UNIQUE INDEX "PushDevice_token_key" ON "PushDevice"("token");
CREATE UNIQUE INDEX "PushDevice_userId_deviceId_key" ON "PushDevice"("userId", "deviceId");
CREATE INDEX "PushDevice_userId_enabled_idx" ON "PushDevice"("userId", "enabled");
CREATE UNIQUE INDEX "IncidentAcknowledgement_alertId_userId_key" ON "IncidentAcknowledgement"("alertId", "userId");
CREATE UNIQUE INDEX "StopEvent_requestKey_key" ON "StopEvent"("requestKey");
CREATE INDEX "StopEvent_tripId_occurredAt_idx" ON "StopEvent"("tripId", "occurredAt");
CREATE INDEX "AccountRequest_schoolId_status_idx" ON "AccountRequest"("schoolId", "status");
