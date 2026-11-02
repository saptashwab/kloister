-- AlterTable
ALTER TABLE "WorkItem" ADD COLUMN     "adHoc" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deleteBatchId" UUID,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" UUID;

-- CreateTable
CREATE TABLE "ItemReference" (
    "id" UUID NOT NULL,
    "sourceItemId" UUID NOT NULL,
    "targetItemId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemReference_targetItemId_idx" ON "ItemReference"("targetItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemReference_sourceItemId_targetItemId_key" ON "ItemReference"("sourceItemId", "targetItemId");

-- CreateIndex
CREATE INDEX "WorkItem_projectId_deletedAt_idx" ON "WorkItem"("projectId", "deletedAt");

-- CreateIndex
CREATE INDEX "WorkItem_deleteBatchId_idx" ON "WorkItem"("deleteBatchId");

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemReference" ADD CONSTRAINT "ItemReference_sourceItemId_fkey" FOREIGN KEY ("sourceItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemReference" ADD CONSTRAINT "ItemReference_targetItemId_fkey" FOREIGN KEY ("targetItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data: Epics and Features no longer have a sprint of their own (M12 plan section 8.1).
-- Each cleared sprint is recorded in the item's history as an unattributed change marked
-- "upgrade": "M12", so the per-project counts for the release notes can be read from the
-- audit log (docs/UPGRADE.md). The id is derived from md5 so no extension is needed.
INSERT INTO "AuditLog" ("id", "actorId", "action", "entityType", "entityId", "projectId", "meta", "createdAt")
SELECT md5(random()::text || clock_timestamp()::text || w."id"::text)::uuid,
       NULL,
       'ITEM_UPDATED',
       'WorkItem',
       w."id"::text,
       w."projectId",
       jsonb_build_object(
         'number', w."number",
         'upgrade', 'M12',
         'changes', jsonb_build_object('sprintId', jsonb_build_object('from', w."sprintId"::text, 'to', NULL))
       ),
       CURRENT_TIMESTAMP
FROM "WorkItem" w
WHERE w."type" IN ('EPIC', 'FEATURE') AND w."sprintId" IS NOT NULL;

UPDATE "WorkItem" SET "sprintId" = NULL
WHERE "type" IN ('EPIC', 'FEATURE') AND "sprintId" IS NOT NULL;
