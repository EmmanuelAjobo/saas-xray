-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "createdById" UUID;

-- CreateIndex
CREATE INDEX "Task_organizationId_createdById_idx" ON "Task"("organizationId", "createdById");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
