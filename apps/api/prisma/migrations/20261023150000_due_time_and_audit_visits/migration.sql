-- AlterTable
ALTER TABLE "WorkItem" ADD COLUMN     "dueTime" SMALLINT;

-- CreateIndex
CREATE INDEX "AuditLog_actorId_action_projectId_createdAt_idx" ON "AuditLog"("actorId", "action", "projectId", "createdAt");
