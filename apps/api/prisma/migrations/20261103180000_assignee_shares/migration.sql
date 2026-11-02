-- AlterTable
ALTER TABLE "WorkItemAssignee" ADD COLUMN     "share" INTEGER NOT NULL DEFAULT 100;

-- Shares are 5 to 100 percent in steps of 5 (M13); every existing row reads 100.
ALTER TABLE "WorkItemAssignee" ADD CONSTRAINT "WorkItemAssignee_share_check" CHECK ("share" BETWEEN 5 AND 100 AND "share" % 5 = 0);
