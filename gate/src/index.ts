import Fastify from "fastify";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { registerRoutes } from "./routes.js";
import { registerUI } from "./ui.js";
import { env } from "./config.js";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
const app = Fastify({ logger: true });

registerRoutes(app, prisma, env.MIN_SETTLE_TIME, env.STALE_TIMEOUT);
registerUI(app);

async function shutdown(signal: string) {
  app.log.info(`Received ${signal}, shutting down gracefully...`);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
