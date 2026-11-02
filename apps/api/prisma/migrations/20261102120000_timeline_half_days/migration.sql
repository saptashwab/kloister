-- AlterTable
ALTER TABLE "WorkItem" ADD COLUMN     "dueFirstHalf" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "startNoEarlierThan" DATE,
ADD COLUMN     "startNoEarlierThanSecondHalf" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "startSecondHalf" BOOLEAN NOT NULL DEFAULT false;
