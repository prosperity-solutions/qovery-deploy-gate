import { cleanEnv, str, port, num } from "envalid";

export const env = cleanEnv(process.env, {
  DATABASE_URL: str({ desc: "PostgreSQL connection URL" }),
  PORT: port({ default: 8080 }),
  HOST: str({ default: "0.0.0.0" }),
  MIN_SETTLE_TIME: num({ default: 30, desc: "Minimum settle time in seconds before gate can open" }),
  STALE_TIMEOUT: num({ default: 300, desc: "Seconds since last /ready ping before an active deployment is marked expired (default 5m)" }),
  POD_STALE_TIMEOUT: num({ default: 90, desc: "Seconds since a pod's last heartbeat before a never-ready pod is treated as terminated and excluded from the gate evaluation (default 90s)" }),
});
