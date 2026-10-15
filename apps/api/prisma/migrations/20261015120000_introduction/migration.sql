-- CreateEnum
CREATE TYPE "IntroductionState" AS ENUM ('AWAITING_INITIAL_PASSWORD', 'READY', 'DISMISSED', 'EXEMPT');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "introductionState" "IntroductionState" NOT NULL DEFAULT 'EXEMPT';
