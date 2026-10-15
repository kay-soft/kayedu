-- SYS: indexes for four hot queries whose read-only EXPLAIN on the dev
-- database showed a filter on a non-leading column or a sort over every row
-- of a centre (docs/08-system-audit.md "Performance"). Additive only — no
-- data, constraint or column changes.
--
-- 1. The session receipt and the roster read a session's payments by
--    "sessionId": only "centerId" was indexed, so every receipt filtered all
--    of the centre's payments (and the "sessionId" foreign key had no index).
CREATE INDEX IF NOT EXISTS "Payment_sessionId_idx" ON "Payment"("sessionId");

-- 2. A student's attendance history and absence streak read by
--    "studentProfileId", which was only the second column of the
--    (sessionId, studentProfileId) unique index.
CREATE INDEX IF NOT EXISTS "SessionAttendee_studentProfileId_idx" ON "SessionAttendee"("studentProfileId");

-- 3. The audit screen reads a centre's newest rows: "centerId" alone meant
--    sorting the centre's whole trail on every page view.
CREATE INDEX IF NOT EXISTS "AuditLog_centerId_createdAt_idx" ON "AuditLog"("centerId", "createdAt");

-- 4. The student portal reads a student's own reservations by "studentId",
--    which was only the second column of the (classGroupId, studentId) key.
CREATE INDEX IF NOT EXISTS "Reservation_studentId_idx" ON "Reservation"("studentId");
