-- CreateIndex
CREATE INDEX "User_schoolId_role_idx" ON "User"("schoolId", "role");

-- CreateIndex
CREATE INDEX "Trip_driverId_status_idx" ON "Trip"("driverId", "status");

-- CreateIndex
CREATE INDEX "Trip_routeId_status_idx" ON "Trip"("routeId", "status");

-- CreateIndex
CREATE INDEX "AttendanceLog_studentId_idx" ON "AttendanceLog"("studentId");

-- CreateIndex
CREATE INDEX "AttendanceLog_tripId_idx" ON "AttendanceLog"("tripId");

-- CreateIndex
CREATE INDEX "LeaveApplication_studentId_status_idx" ON "LeaveApplication"("studentId", "status");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);
