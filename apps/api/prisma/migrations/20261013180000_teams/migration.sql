-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('LEAD', 'MEMBER');

-- AlterEnum
ALTER TYPE "Visibility" ADD VALUE 'TEAMS';

-- CreateTable
CREATE TABLE "Team" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "TeamRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Team_projectId_name_key" ON "Team"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Team_id_projectId_key" ON "Team"("id", "projectId");

-- CreateIndex
CREATE INDEX "TeamMember_projectId_userId_idx" ON "TeamMember"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_projectId_fkey" FOREIGN KEY ("teamId", "projectId") REFERENCES "Team"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_projectId_userId_fkey" FOREIGN KEY ("projectId", "userId") REFERENCES "ProjectMember"("projectId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
