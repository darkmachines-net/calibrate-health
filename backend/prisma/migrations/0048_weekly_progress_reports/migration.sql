CREATE TABLE "WeeklyProgressReport" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "report_date" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "model" TEXT,
    "summary" TEXT,
    "highlights" JSONB,
    "next_step" TEXT,
    "evidence" JSONB,
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WeeklyProgressReport_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WeeklyProgressReport_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'READY')),
    CONSTRAINT "WeeklyProgressReport_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WeeklyProgressReport_user_id_report_date_key" ON "WeeklyProgressReport"("user_id", "report_date");
