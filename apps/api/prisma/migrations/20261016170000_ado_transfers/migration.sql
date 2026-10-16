-- CreateTable
CREATE TABLE "AdoDestination" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "organization" TEXT NOT NULL,
    "remoteProject" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdoDestination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdoItemLink" (
    "id" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "remoteId" TEXT,
    "tombstonedAt" TIMESTAMP(3),
    "localBaseline" JSONB NOT NULL DEFAULT '{}',
    "remoteBaseline" JSONB NOT NULL DEFAULT '{}',
    "observation" JSONB NOT NULL DEFAULT '{}',
    "observedAt" TIMESTAMP(3),
    "observationRevision" INTEGER,
    "pendingBatchId" UUID,
    "generatedSuffix" TEXT NOT NULL DEFAULT '',
    "intent" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdoItemLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdoTransferBatch" (
    "id" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PREVIEW',
    "revision" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "fileDigest" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "completedAt" TIMESTAMP(3),
    "contentExpiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdoTransferBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdoTransferRow" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "itemId" UUID,
    "remoteId" TEXT,
    "result" TEXT NOT NULL,
    "content" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdoTransferRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdoDestination_projectId_key" ON "AdoDestination"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AdoDestination_id_projectId_key" ON "AdoDestination"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AdoItemLink_reference_key" ON "AdoItemLink"("reference");

-- CreateIndex
CREATE INDEX "AdoItemLink_projectId_itemId_idx" ON "AdoItemLink"("projectId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "AdoItemLink_destinationId_itemId_key" ON "AdoItemLink"("destinationId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "AdoItemLink_destinationId_remoteId_key" ON "AdoItemLink"("destinationId", "remoteId");

-- CreateIndex
CREATE INDEX "AdoTransferBatch_state_completedAt_idx" ON "AdoTransferBatch"("state", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdoTransferBatch_destinationId_idempotencyKey_key" ON "AdoTransferBatch"("destinationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AdoTransferBatch_id_projectId_key" ON "AdoTransferBatch"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AdoTransferRow_batchId_index_key" ON "AdoTransferRow"("batchId", "index");

-- AddForeignKey
ALTER TABLE "AdoDestination" ADD CONSTRAINT "AdoDestination_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdoItemLink" ADD CONSTRAINT "AdoItemLink_destinationId_projectId_fkey" FOREIGN KEY ("destinationId", "projectId") REFERENCES "AdoDestination"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdoTransferBatch" ADD CONSTRAINT "AdoTransferBatch_destinationId_projectId_fkey" FOREIGN KEY ("destinationId", "projectId") REFERENCES "AdoDestination"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdoTransferRow" ADD CONSTRAINT "AdoTransferRow_batchId_projectId_fkey" FOREIGN KEY ("batchId", "projectId") REFERENCES "AdoTransferBatch"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
