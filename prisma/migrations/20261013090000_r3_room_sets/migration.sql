-- R3: joinable rooms, multi-room classes/sessions, capacity from rooms
-- (docs/00-master-product-spec.md §5.1 "Joinable rooms / room sets",
-- "Class capacity removed", "Double-booking needs explicit confirmation";
-- docs/03-build-order.md "R3").
--
-- No production data exists when this migration runs: every database it
-- targets holds seed/demo data only.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. ClassGroup.capacity is dropped. This REVERSES M15's "enrolment cap =
--    min(class capacity, room capacity)": a class's seat limit is now the
--    summed capacity of its room set (primary + extra rooms) and nothing
--    else (lib/rooms.ts, lib/capacity.ts). Old ChangeRequest payloads may
--    still carry a "capacity" key; that JSON is left as written and every
--    reader ignores the key.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "ClassGroup" DROP COLUMN "capacity";

-- CreateTable
CREATE TABLE "RoomLink" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "roomAId" TEXT NOT NULL,
    "roomBId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassGroupRoom" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "classGroupId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassGroupRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionRoom" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionRoom_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomLink_centerId_idx" ON "RoomLink"("centerId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomLink_roomAId_roomBId_key" ON "RoomLink"("roomAId", "roomBId");

-- CreateIndex
CREATE INDEX "ClassGroupRoom_centerId_idx" ON "ClassGroupRoom"("centerId");

-- CreateIndex
CREATE INDEX "ClassGroupRoom_centerId_roomId_idx" ON "ClassGroupRoom"("centerId", "roomId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassGroupRoom_classGroupId_roomId_key" ON "ClassGroupRoom"("classGroupId", "roomId");

-- CreateIndex
CREATE INDEX "SessionRoom_centerId_idx" ON "SessionRoom"("centerId");

-- CreateIndex
CREATE INDEX "SessionRoom_centerId_roomId_idx" ON "SessionRoom"("centerId", "roomId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionRoom_sessionId_roomId_key" ON "SessionRoom"("sessionId", "roomId");

-- AddForeignKey
ALTER TABLE "RoomLink" ADD CONSTRAINT "RoomLink_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomLink" ADD CONSTRAINT "RoomLink_roomAId_fkey" FOREIGN KEY ("roomAId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomLink" ADD CONSTRAINT "RoomLink_roomBId_fkey" FOREIGN KEY ("roomBId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassGroupRoom" ADD CONSTRAINT "ClassGroupRoom_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassGroupRoom" ADD CONSTRAINT "ClassGroupRoom_classGroupId_fkey" FOREIGN KEY ("classGroupId") REFERENCES "ClassGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassGroupRoom" ADD CONSTRAINT "ClassGroupRoom_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionRoom" ADD CONSTRAINT "SessionRoom_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionRoom" ADD CONSTRAINT "SessionRoom_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionRoom" ADD CONSTRAINT "SessionRoom_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────
-- 2. Database backstop for the link invariants lib/db/room-sets.ts already
--    enforces: a pair is stored once, normalized (roomAId < roomBId, which
--    also rules out a self-link). Cross-centre links are refused by the
--    writer, which resolves both rooms inside the link's own centre.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "RoomLink" ADD CONSTRAINT "RoomLink_normalized_pair_check" CHECK ("roomAId" < "roomBId");
