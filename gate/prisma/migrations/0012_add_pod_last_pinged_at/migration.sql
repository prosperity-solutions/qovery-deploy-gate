-- Per-pod heartbeat timestamp. Used to detect pods that registered but were
-- terminated (e.g. HPA scale-down, eviction) before ever reporting ready, so
-- the gate doesn't wait forever on a dead pod.
ALTER TABLE "deployment_services"
  ADD COLUMN "last_pinged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
