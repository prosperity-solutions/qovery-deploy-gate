import { cleanEnv, str, port, num } from "envalid";

export const env = cleanEnv(process.env, {
  DATABASE_URL: str({ desc: "PostgreSQL connection URL" }),
  PORT: port({ default: 8080 }),
  HOST: str({ default: "0.0.0.0" }),
  MIN_SETTLE_TIME: num({ default: 30, desc: "Minimum settle time in seconds before gate can open" }),
});
