-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('EPIC', 'FEATURE', 'STORY', 'TASK', 'BUG');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'DONE');

-- CreateEnum
CREATE TYPE "BucketRule" AS ENUM ('NONE', 'SET', 'SET_IF_NOT_STARTED');

-- CreateEnum
CREATE TYPE "SprintState" AS ENUM ('PLANNED', 'ACTIVE', 'CLOSED');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "lastItemNumber" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Bucket" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "onEnterMode" "BucketRule" NOT NULL DEFAULT 'NONE',
    "onEnterStatus" "ItemStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sprint" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "state" "SprintState" NOT NULL DEFAULT 'PLANNED',
    "adoIterationPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Label" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "ItemType" NOT NULL,
    "parentId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "ItemStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "priority" INTEGER NOT NULL DEFAULT 2,
    "bucketId" UUID,
    "sprintId" UUID,
    "teamId" UUID,
    "startDate" DATE,
    "dueDate" DATE,
    "position" DOUBLE PRECISION NOT NULL,
    "createdById" UUID NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItemAssignee" (
    "id" UUID NOT NULL,
    "workItemId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItemAssignee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItemDependency" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "blockedItemId" UUID NOT NULL,
    "blockingItemId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItemDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItemLabel" (
    "id" UUID NOT NULL,
    "workItemId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "labelId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItemLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" UUID NOT NULL,
    "workItemId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "position" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bucket_projectId_position_idx" ON "Bucket"("projectId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Bucket_id_projectId_key" ON "Bucket"("id", "projectId");

-- CreateIndex
CREATE INDEX "Sprint_projectId_startDate_idx" ON "Sprint"("projectId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "Label_projectId_name_key" ON "Label"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Label_id_projectId_key" ON "Label"("id", "projectId");

-- CreateIndex
CREATE INDEX "WorkItem_projectId_bucketId_position_idx" ON "WorkItem"("projectId", "bucketId", "position");

-- CreateIndex
CREATE INDEX "WorkItem_parentId_idx" ON "WorkItem"("parentId");

-- CreateIndex
CREATE INDEX "WorkItem_sprintId_idx" ON "WorkItem"("sprintId");

-- CreateIndex
CREATE INDEX "WorkItem_teamId_idx" ON "WorkItem"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItem_projectId_number_key" ON "WorkItem"("projectId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItem_id_projectId_key" ON "WorkItem"("id", "projectId");

-- CreateIndex
CREATE INDEX "WorkItemAssignee_projectId_userId_idx" ON "WorkItemAssignee"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItemAssignee_workItemId_userId_key" ON "WorkItemAssignee"("workItemId", "userId");

-- CreateIndex
CREATE INDEX "WorkItemDependency_blockingItemId_idx" ON "WorkItemDependency"("blockingItemId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItemDependency_blockedItemId_blockingItemId_key" ON "WorkItemDependency"("blockedItemId", "blockingItemId");

-- CreateIndex
CREATE INDEX "WorkItemLabel_labelId_idx" ON "WorkItemLabel"("labelId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItemLabel_workItemId_labelId_key" ON "WorkItemLabel"("workItemId", "labelId");

-- CreateIndex
CREATE INDEX "ChecklistItem_workItemId_position_idx" ON "ChecklistItem"("workItemId", "position");

-- AddForeignKey
ALTER TABLE "Bucket" ADD CONSTRAINT "Bucket_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sprint" ADD CONSTRAINT "Sprint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Label" ADD CONSTRAINT "Label_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_parentId_projectId_fkey" FOREIGN KEY ("parentId", "projectId") REFERENCES "WorkItem"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_bucketId_projectId_fkey" FOREIGN KEY ("bucketId", "projectId") REFERENCES "Bucket"("id", "projectId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "Sprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItemAssignee" ADD CONSTRAINT "WorkItemAssignee_workItemId_projectId_fkey" FOREIGN KEY ("workItemId", "projectId") REFERENCES "WorkItem"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItemAssignee" ADD CONSTRAINT "WorkItemAssignee_projectId_userId_fkey" FOREIGN KEY ("projectId", "userId") REFERENCES "ProjectMember"("projectId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItemDependency" ADD CONSTRAINT "WorkItemDependency_blockedItemId_projectId_fkey" FOREIGN KEY ("blockedItemId", "projectId") REFERENCES "WorkItem"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItemDependency" ADD CONSTRAINT "WorkItemDependency_blockingItemId_projectId_fkey" FOREIGN KEY ("blockingItemId", "projectId") REFERENCES "WorkItem"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItemLabel" ADD CONSTRAINT "WorkItemLabel_workItemId_projectId_fkey" FOREIGN KEY ("workItemId", "projectId") REFERENCES "WorkItem"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItemLabel" ADD CONSTRAINT "WorkItemLabel_labelId_projectId_fkey" FOREIGN KEY ("labelId", "projectId") REFERENCES "Label"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Give projects created before work items existed the default buckets of
-- SPEC §4.2; projects created from now on get them from the API.
INSERT INTO "Bucket" ("id", "projectId", "name", "position", "onEnterMode", "onEnterStatus", "updatedAt")
SELECT gen_random_uuid(), p."id", b.name, b.position, b.mode::"BucketRule", b.status::"ItemStatus", CURRENT_TIMESTAMP
FROM "Project" p
CROSS JOIN (VALUES
  ('Backlog', 1024, 'NONE', NULL),
  ('To Do', 2048, 'NONE', NULL),
  ('In Progress', 3072, 'SET_IF_NOT_STARTED', 'IN_PROGRESS'),
  ('Done', 4096, 'SET', 'DONE')
) AS b(name, position, mode, status)
WHERE NOT EXISTS (SELECT 1 FROM "Bucket" x WHERE x."projectId" = p."id");
