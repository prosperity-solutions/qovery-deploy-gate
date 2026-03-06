import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { registerRoutes } from "./routes.js";

const DATABASE_URL = process.env.DATABASE_URL;

// Skip all tests if no database is available
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb("API Routes (integration)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const adapter = new PrismaPg({ connectionString: DATABASE_URL! });
    prisma = new PrismaClient({ adapter });
    app = Fastify();
    registerRoutes(app, prisma, 0, 300); // 0s settle time, 300s stale timeout
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up test data
    await prisma.deploymentService.deleteMany();
    await prisma.deployment.deleteMany();
  });

  it("GET /healthz returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("POST /register creates deployment and service", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/register",
      payload: {
        deployment_id: "dep-1",
        service_id: "svc-a",
        pod_name: "svc-a-pod-1",
        namespace: "default",
        group: "web",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.deployment_id).toBe("dep-1");
    expect(body.service_id).toBe("svc-a");
    expect(body.pod_name).toBe("svc-a-pod-1");
    expect(body.already_registered).toBe(false);

    // Verify in DB
    const deployment = await prisma.deployment.findUnique({
      where: { deploymentId: "dep-1" },
    });
    expect(deployment).not.toBeNull();
    expect(deployment!.lastPingedAt).toBeDefined();
  });

  it("POST /register is idempotent", async () => {
    const payload = {
      deployment_id: "dep-2",
      service_id: "svc-b",
      pod_name: "svc-b-pod-1",
      namespace: "default",
      group: "web",
    };

    const res1 = await app.inject({
      method: "POST",
      url: "/register",
      payload,
    });
    expect(res1.statusCode).toBe(201);

    const res2 = await app.inject({
      method: "POST",
      url: "/register",
      payload,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().already_registered).toBe(true);

    // Should still be just one service record
    const services = await prisma.deploymentService.findMany({
      where: { deploymentId: "dep-2" },
    });
    expect(services).toHaveLength(1);
  });

  it("POST /register creates separate records for different pods of the same service", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-2b", service_id: "svc-a", pod_name: "svc-a-pod-1", namespace: "default", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-2b", service_id: "svc-a", pod_name: "svc-a-pod-2", namespace: "default", group: "web" },
    });

    const services = await prisma.deploymentService.findMany({
      where: { deploymentId: "dep-2b" },
    });
    expect(services).toHaveLength(2);
  });

  it("POST /ready returns error for unknown deployment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: {
        deployment_id: "nonexistent",
        service_id: "svc-x",
        pod_name: "pod-x",
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().gate_status).toBe("error");
    expect(res.json().reason).toContain("nonexistent");
  });

  it("POST /ready returns error for unregistered pod", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: {
        deployment_id: "dep-3",
        service_id: "svc-a",
        pod_name: "svc-a-pod-1",
        group: "web",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: {
        deployment_id: "dep-3",
        service_id: "svc-a",
        pod_name: "unknown-pod",
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().gate_status).toBe("error");
  });

  it("POST /ready returns waiting when group is incomplete", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-4", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-4", service_id: "svc-b", pod_name: "svc-b-pod-1", group: "web" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-4", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gate_status).toBe("waiting");
    expect(body.group_services_total).toBe(2);
    expect(body.group_services_ready).toBe(1);
    expect(body.pending_services).toContain("svc-b/svc-b-pod-1");
  });

  it("POST /ready waits for all pods of the same service", async () => {
    // Two pods of the same service
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-4b", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-4b", service_id: "svc-a", pod_name: "svc-a-pod-2", group: "web" },
    });

    // Only one pod ready
    const res1 = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-4b", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });
    expect(res1.json().gate_status).toBe("waiting");
    expect(res1.json().group_services_total).toBe(2);
    expect(res1.json().group_services_ready).toBe(1);

    // Both pods ready
    const res2 = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-4b", service_id: "svc-a", pod_name: "svc-a-pod-2" },
    });
    expect(res2.json().gate_status).toBe("open");
    expect(res2.json().group_services_ready).toBe(2);
  });

  it("POST /ready returns open when group complete and settle time passed", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-5", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-5", service_id: "svc-b", pod_name: "svc-b-pod-1", group: "web" },
    });

    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-5", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-5", service_id: "svc-b", pod_name: "svc-b-pod-1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gate_status).toBe("open");
    expect(body.group_services_total).toBe(2);
    expect(body.group_services_ready).toBe(2);
  });

  it("POST /ready returns open when called again after all pods ready", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-7", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-7", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-7", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().gate_status).toBe("open");
    expect(res.json().group_services_total).toBe(1);
    expect(res.json().group_services_ready).toBe(1);
  });

  it("GET /status returns deployment data with pod info", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-8", service_id: "svc-a", pod_name: "svc-a-pod-1", namespace: "prod", group: "web" },
    });

    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.active).toHaveLength(1);
    expect(body.active[0].deployment_id).toBe("dep-8");
    expect(body.active[0].groups.web.services[0].pod_name).toBe("svc-a-pod-1");
    expect(body.active[0].groups.web.services[0].namespace).toBe("prod");
    expect(body.recent_completed).toHaveLength(0);
  });

  it("GET /status derives COMPLETED status when all pods are ready", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-9", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-9", service_id: "svc-b", pod_name: "svc-b-pod-1", group: "workers" },
    });
    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-9", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });
    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-9", service_id: "svc-b", pod_name: "svc-b-pod-1" },
    });

    const res = await app.inject({ method: "GET", url: "/status" });
    const body = res.json();

    expect(body.active).toHaveLength(0);
    expect(body.recent_completed).toHaveLength(1);
    expect(body.recent_completed[0].deployment_id).toBe("dep-9");
    expect(body.recent_completed[0].status).toBe("COMPLETED");
  });

  it("POST /ready expires stale deployment and returns open", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-10", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });

    const staleTime = new Date(Date.now() - 600_000);
    await prisma.deployment.update({
      where: { deploymentId: "dep-10" },
      data: { lastPingedAt: staleTime },
    });

    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-10", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().gate_status).toBe("open");
    expect(res.json().message).toBe("Deployment expired");
  });

  it("GET /status derives EXPIRED for stale deployments", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-11", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });

    const staleTime = new Date(Date.now() - 600_000);
    await prisma.deployment.update({
      where: { deploymentId: "dep-11" },
      data: { lastPingedAt: staleTime },
    });

    const res = await app.inject({ method: "GET", url: "/status" });
    const body = res.json();

    expect(body.active).toHaveLength(0);
    expect(body.recent_expired).toHaveLength(1);
    expect(body.recent_expired[0].deployment_id).toBe("dep-11");
  });

  it("GET /status shows completed deployment as COMPLETED even after stale timeout", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-12", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-12", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });

    const staleTime = new Date(Date.now() - 600_000);
    await prisma.deployment.update({
      where: { deploymentId: "dep-12" },
      data: { lastPingedAt: staleTime },
    });

    const res = await app.inject({ method: "GET", url: "/status" });
    const body = res.json();

    expect(body.recent_completed).toHaveLength(1);
    expect(body.recent_completed[0].deployment_id).toBe("dep-12");
    expect(body.recent_completed[0].status).toBe("COMPLETED");
    expect(body.recent_expired).toHaveLength(0);
  });
});

describe("API Routes (unit - no DB)", () => {
  it("GET /healthz returns 200 without database", async () => {
    const app = Fastify();
    registerRoutes(app, {} as PrismaClient, 30, 300);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    await app.close();
  });
});
