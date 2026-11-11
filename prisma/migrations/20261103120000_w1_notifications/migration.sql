-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('ENROLLMENT_APPROVED', 'ENROLLMENT_DECLINED', 'BOOKING_APPROVED', 'BOOKING_DECLINED', 'SESSION_CANCELLED', 'SESSION_RESCHEDULED');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "centerId" TEXT,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_centerId_idx" ON "Notification"("centerId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ── Hand-written (W1) ─────────────────────────────────────────────────────

-- Every table in `public` has RLS on with zero policies (docs/02 §12,
-- `check:rls`); a new table enables it in its own migration.
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;

-- Ids only (D-W12, the D-20 audit rule): the payload is a flat JSON object
-- whose every value is a row id (every id the payload names is a uuid) —
-- never a name, a contact, a number or free text. lib/db/notifications.ts
-- refuses first; this is the backstop.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_payload_ids_only_check"
  CHECK (
    jsonb_typeof("payload") = 'object'
    AND NOT jsonb_path_exists(
      "payload",
      '$.* ? (@.type() != "string" || !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))'
    )
  );
