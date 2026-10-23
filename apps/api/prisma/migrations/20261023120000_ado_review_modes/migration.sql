-- AlterTable
ALTER TABLE "AdoDestination" ADD COLUMN     "requireDetailedReview" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AdoTransferBatch" ADD COLUMN     "review" TEXT NOT NULL DEFAULT 'detailed';
