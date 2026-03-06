import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { registerRoutes } from "./routes.js";

const DATABASE_URL = process.env.DATABASE_URL;

// Skip all tests if no database is available
const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb("API Routes (integration)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    app = Fastify();
    registerRoutes(app, prisma, 0); // 0s settle time for fast tests
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
        group: "web",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.deployment_id).toBe("dep-1");
    expect(body.service_id).toBe("svc-a");
    expect(body.group).toBe("web");
    expect(body.already_registered).toBe(false);

    // Verify in DB
    const deployment = await prisma.deployment.findUnique({
      where: { deploymentId: "dep-1" },
    });
    expect(deployment).not.toBeNull();
    expect(deployment!.status).toBe("ACTIVE");
  });

  it("POST /register is idempotent", async () => {
    const payload = {
      deployment_id: "dep-2",
      service_id: "svc-b",
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

  it("POST /ready returns error for unknown deployment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: {
        deployment_id: "nonexistent",
        service_id: "svc-x",
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().gate_status).toBe("error");
    expect(res.json().reason).toContain("nonexistent");
  });

  it("POST /ready returns error for unregistered service", async () => {
    // Register one service
    await app.inject({
      method: "POST",
      url: "/register",
      payload: {
        deployment_id: "dep-3",
        service_id: "svc-a",
        group: "web",
      },
    });

    // Try to ready a different service
    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: {
        deployment_id: "dep-3",
        service_id: "svc-unknown",
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().gate_status).toBe("error");
  });

  it("POST /ready returns waiting when group is incomplete", async () => {
    // Register two services in the same group
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-4", service_id: "svc-a", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-4", service_id: "svc-b", group: "web" },
    });

    // Only mark one as ready
    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-4", service_id: "svc-a" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gate_status).toBe("waiting");
    expect(body.group_services_total).toBe(2);
    expect(body.group_services_ready).toBe(1);
    expect(body.pending_services).toContain("svc-b");
  });

  it("POST /ready returns open when group complete and settle time passed", async () => {
    // Using 0s settle time in test setup
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-5", service_id: "svc-a", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-5", service_id: "svc-b", group: "web" },
    });

    // Mark both as ready
    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-5", service_id: "svc-a" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-5", service_id: "svc-b" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gate_status).toBe("open");
    expect(body.group_services_total).toBe(2);
    expect(body.group_services_ready).toBe(2);
  });

  it("POST /ready transitions deployment to COMPLETED when all groups ready", async () => {
    // Two groups, one service each
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-6", service_id: "svc-a", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-6", service_id: "svc-b", group: "workers" },
    });

    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-6", service_id: "svc-a" },
    });
    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-6", service_id: "svc-b" },
    });

    const deployment = await prisma.deployment.findUnique({
      where: { deploymentId: "dep-6" },
    });
    expect(deployment!.status).toBe("COMPLETED");
    expect(deployment!.completedAt).not.toBeNull();
  });

  it("POST /ready returns open for already completed deployment", async () => {
    // Create and complete a deployment
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-7", service_id: "svc-a", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-7", service_id: "svc-a" },
    });

    // Should be completed now, call ready again
    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-7", service_id: "svc-a" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().gate_status).toBe("open");
    expect(res.json().message).toContain("already completed");
  });

  it("GET /status returns deployment data", async () => {
    // Create an active deployment
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-8", service_id: "svc-a", group: "web" },
    });

    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.active).toHaveLength(1);
    expect(body.active[0].deployment_id).toBe("dep-8");
    expect(body.active[0].groups.web).toBeDefined();
    expect(body.active[0].groups.web.total).toBe(1);
    expect(body.active[0].groups.web.ready).toBe(0);
    expect(body.recent_completed).toHaveLength(0);
  });
});

describe("API Routes (unit - no DB)", () => {
  it("GET /healthz returns 200 without database", async () => {
    const app = Fastify();
    // Pass a dummy prisma - healthz doesn't use it
    registerRoutes(app, {} as PrismaClient, 30);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    await app.close();
  });
});
