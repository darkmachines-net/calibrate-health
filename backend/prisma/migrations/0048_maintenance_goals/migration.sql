ALTER TABLE "Goal"
    ADD COLUMN "maintenance_lower_grams" INTEGER,
    ADD COLUMN "maintenance_upper_grams" INTEGER,
    ADD COLUMN "recovery_maintenance_goal_id" INTEGER,
    ADD COLUMN "predecessor_goal_id" INTEGER,
    ADD COLUMN "start_from_trend" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "completed_on" DATE,
    ADD COLUMN "completion_source_revision" VARCHAR(64);

ALTER TABLE "Goal" ADD CONSTRAINT "Goal_maintenance_range_check" CHECK (
    ("maintenance_lower_grams" IS NULL AND "maintenance_upper_grams" IS NULL)
    OR ("daily_deficit" = 0 AND "maintenance_lower_grams" IS NOT NULL
        AND "maintenance_upper_grams" IS NOT NULL
        AND "maintenance_lower_grams" < "target_weight_grams"
        AND "target_weight_grams" < "maintenance_upper_grams")
);

CREATE TABLE "MaintenanceGoalRevision" (
    "id" SERIAL PRIMARY KEY,
    "goal_id" INTEGER NOT NULL REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "target_weight_grams" INTEGER NOT NULL,
    "lower_weight_grams" INTEGER,
    "upper_weight_grams" INTEGER,
    "effective_local_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MaintenanceGoalRevision_goal_id_id_idx" ON "MaintenanceGoalRevision"("goal_id", "id");

ALTER TABLE "CaloriePlanRevision" ADD COLUMN "manual_maintenance" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CaloriePlanRevision" ADD CONSTRAINT "CaloriePlanRevision_manual_maintenance_check"
    CHECK (NOT "manual_maintenance" OR ("configured_daily_deficit" IS NULL AND "target_adjustment_kcal" IN (-250, 0, 250)));
