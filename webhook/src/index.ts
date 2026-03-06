import Fastify from "fastify";
import fs from "fs";
import { registerWebhook } from "./webhook.js";

const tlsCert = process.env.TLS_CERT_PATH || "/certs/tls.crt";
const tlsKey = process.env.TLS_KEY_PATH || "/certs/tls.key";

const app = Fastify({
  logger: true,
  https: {
    cert: fs.readFileSync(tlsCert),
    key: fs.readFileSync(tlsKey),
  },
});

const gateUrl =
  process.env.GATE_URL || "http://qovery-deploy-gate.qovery-deploy-gate.svc:8080";
const sidecarImage =
  process.env.SIDECAR_IMAGE ||
  "ghcr.io/prosperity-solutions/qovery-deploy-gate/sidecar:latest";
const pollInterval = process.env.POLL_INTERVAL || "5";

registerWebhook(app, { gateUrl, sidecarImage, pollInterval });

// Healthz endpoint (HTTP would need separate server, but just use the same HTTPS one)
app.get("/healthz", async () => ({ status: "ok" }));

async function shutdown(signal: string) {
  app.log.info(`Received ${signal}, shutting down gracefully...`);
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const port = parseInt(process.env.PORT || "8443", 10);
app.listen({ port, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
