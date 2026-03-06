import Fastify from "fastify";
import { PrismaClient } from "@prisma/client";
import { registerRoutes } from "./routes.js";
import { registerUI } from "./ui.js";
import { env } from "./config.js";

const prisma = new PrismaClient();
const app = Fastify({ logger: true });

registerRoutes(app, prisma, env.MIN_SETTLE_TIME);
registerUI(app);

async function shutdown(signal: string) {
  app.log.info(`Received ${signal}, shutting down gracefully...`);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.listen({ port: env.PORT, host: env.HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
