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
    // CASCADE deletes clean up related services, expected services, and completed groups
    await prisma.deployment.deleteMany();
  });

  it("GET /healthz returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  // --- /expect tests ---

  it("POST /expect creates expected service record", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-e1", service_id: "svc-a", group: "web" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.deployment_id).toBe("dep-e1");
    expect(body.service_id).toBe("svc-a");
    expect(body.already_expected).toBe(false);

    const expected = await prisma.expectedService.findMany({ where: { deploymentId: "dep-e1" } });
    expect(expected).toHaveLength(1);
    expect(expected[0].serviceId).toBe("svc-a");
  });

  it("POST /expect is idempotent", async () => {
    const payload = { deployment_id: "dep-e2", service_id: "svc-a", group: "web" };

    const res1 = await app.inject({ method: "POST", url: "/expect", payload });
    expect(res1.statusCode).toBe(201);

    const res2 = await app.inject({ method: "POST", url: "/expect", payload });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().already_expected).toBe(true);

    const expected = await prisma.expectedService.findMany({ where: { deploymentId: "dep-e2" } });
    expect(expected).toHaveLength(1);
  });

  it("POST /expect creates deployment record", async () => {
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-e3", service_id: "svc-a", group: "web" },
    });

    const deployment = await prisma.deployment.findUnique({ where: { deploymentId: "dep-e3" } });
    expect(deployment).not.toBeNull();
  });

  // --- /register tests ---

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

  it("POST /register also creates expected service record (belt-and-suspenders)", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-belt", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });

    const expected = await prisma.expectedService.findMany({ where: { deploymentId: "dep-belt" } });
    expect(expected).toHaveLength(1);
    expect(expected[0].serviceId).toBe("svc-a");
    expect(expected[0].groupName).toBe("web");
  });

  it("POST /register corrects expected service group when mismatched with /expect", async () => {
    // Webhook registers with group "wrong-group"
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-mismatch", service_id: "svc-a", group: "wrong-group" },
    });

    // Sidecar registers with correct group "web"
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-mismatch", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });

    const expected = await prisma.expectedService.findUnique({
      where: { deploymentId_serviceId: { deploymentId: "dep-mismatch", serviceId: "svc-a" } },
    });
    // Sidecar's group wins
    expect(expected!.groupName).toBe("web");
  });

  it("POST /register refreshes lastPingedAt on new registration", async () => {
    // Simulate /expect having been called a while ago
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-ping", service_id: "svc-a", group: "web" },
    });

    // Simulate time passing
    const oldTime = new Date(Date.now() - 200_000);
    await prisma.deployment.update({
      where: { deploymentId: "dep-ping" },
      data: { lastPingedAt: oldTime },
    });

    // Sidecar registers — should refresh lastPingedAt
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-ping", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });

    const dep = await prisma.deployment.findUnique({ where: { deploymentId: "dep-ping" } });
    expect(dep!.lastPingedAt.getTime()).toBeGreaterThan(oldTime.getTime());
  });

  it("POST /register refreshes lastPingedAt on idempotent call", async () => {
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-idem-ping", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });

    // Simulate time passing
    const oldTime = new Date(Date.now() - 200_000);
    await prisma.deployment.update({
      where: { deploymentId: "dep-idem-ping" },
      data: { lastPingedAt: oldTime },
    });

    // Idempotent re-register should still refresh lastPingedAt
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-idem-ping", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });

    const dep = await prisma.deployment.findUnique({ where: { deploymentId: "dep-idem-ping" } });
    expect(dep!.lastPingedAt.getTime()).toBeGreaterThan(oldTime.getTime());
  });

  // --- /ready tests ---

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
    expect(res.json().error_code).toBe("not_found");
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
    expect(res.json().error_code).toBe("not_found");
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
    expect(body.pending_pods).toContain("svc-b/svc-b-pod-1");
    // Backward compat: pending_services still present
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
    // Second call hits completed group shortcut
    expect(res.json().message).toBe("Group already completed");
  });

  // --- /ready + /expect interaction tests ---

  it("POST /ready waits for expected services that haven't registered pods yet", async () => {
    // Webhook pre-registers two expected services
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-exp1", service_id: "svc-a", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-exp1", service_id: "svc-b", group: "web" },
    });

    // Only svc-a's sidecar has registered and is ready
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-exp1", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-exp1", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gate_status).toBe("waiting");
    expect(body.missing_services).toContain("svc-b");
  });

  it("POST /ready opens when all expected services have registered pods", async () => {
    // Webhook pre-registers
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-exp2", service_id: "svc-a", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-exp2", service_id: "svc-b", group: "web" },
    });

    // Both sidecars register
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-exp2", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-exp2", service_id: "svc-b", pod_name: "svc-b-pod-1", group: "web" },
    });

    // Both report ready
    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-exp2", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-exp2", service_id: "svc-b", pod_name: "svc-b-pod-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().gate_status).toBe("open");
  });

  it("POST /ready isolates groups — group A opening does not affect group B", async () => {
    // Group A: svc-a
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-iso", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "group-a" },
    });
    // Group B: svc-b (not ready yet)
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-iso", service_id: "svc-b", pod_name: "svc-b-pod-1", group: "group-b" },
    });

    // svc-a reports ready — group A should open (only one member)
    const resA = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-iso", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });
    expect(resA.json().gate_status).toBe("open");
    expect(resA.json().group).toBe("group-a");

    // svc-b not yet ready — group B should still be waiting
    const resB = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-iso", service_id: "svc-b", pod_name: "svc-b-pod-1" },
    });
    // svc-b just reported ready and it's the only member of group-b, so it opens too
    expect(resB.json().gate_status).toBe("open");
    expect(resB.json().group).toBe("group-b");
  });

  it("POST /ready cross-group isolation — pending in one group doesn't block another", async () => {
    // Group A: svc-a and svc-b
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-iso2", service_id: "svc-a", group: "group-a" },
    });
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-iso2", service_id: "svc-b", group: "group-a" },
    });
    // Group B: svc-c
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-iso2", service_id: "svc-c", group: "group-b" },
    });

    // Only svc-a and svc-c register
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-iso2", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "group-a" },
    });
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-iso2", service_id: "svc-c", pod_name: "svc-c-pod-1", group: "group-b" },
    });

    // Group A should be waiting (svc-b missing)
    const resA = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-iso2", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });
    expect(resA.json().gate_status).toBe("waiting");
    expect(resA.json().missing_services).toContain("svc-b");

    // Group B should be open (svc-c is the only expected member)
    const resB = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-iso2", service_id: "svc-c", pod_name: "svc-c-pod-1" },
    });
    expect(resB.json().gate_status).toBe("open");
  });

  it("POST /ready opens without /expect if no expected services exist (backwards compatible)", async () => {
    // No /expect calls — only sidecar registration (no webhook pre-registration)
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-noexp", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-noexp", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().gate_status).toBe("open");
  });

  // --- completed group / autoscaling tests ---

  it("POST /ready returns instant open for autoscaling pods after group completed", async () => {
    // Deploy svc-a, make it ready — gate opens and records completion
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-auto", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    const openRes = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-auto", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });
    expect(openRes.json().gate_status).toBe("open");

    // Verify completion was recorded
    const cg = await prisma.completedGroup.findUnique({
      where: { deploymentId_groupName: { deploymentId: "dep-auto", groupName: "web" } },
    });
    expect(cg).not.toBeNull();

    // Autoscaler adds a new pod — register + ready should get instant open
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-auto", service_id: "svc-a", pod_name: "svc-a-pod-2", group: "web" },
    });
    const autoRes = await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-auto", service_id: "svc-a", pod_name: "svc-a-pod-2" },
    });
    expect(autoRes.json().gate_status).toBe("open");
    expect(autoRes.json().message).toBe("Group already completed");
  });

  it("POST /register does not create expected service for autoscaling pod after group completed", async () => {
    // Complete the group
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-auto2", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-auto2", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });

    // Autoscaler adds a new service type (shouldn't happen, but tests the guard)
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-auto2", service_id: "svc-new", pod_name: "svc-new-pod-1", group: "web" },
    });

    // Should NOT have created an expected service for svc-new
    const expected = await prisma.expectedService.findUnique({
      where: { deploymentId_serviceId: { deploymentId: "dep-auto2", serviceId: "svc-new" } },
    });
    expect(expected).toBeNull();
  });

  it("GET /status hides autoscaling pods that registered after group completion", async () => {
    // Complete a deployment
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-auto3", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-auto3", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });

    // Autoscaler adds a pod after completion
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-auto3", service_id: "svc-a", pod_name: "svc-a-pod-2", group: "web" },
    });

    const res = await app.inject({ method: "GET", url: "/status" });
    const body = res.json();

    // Should show as completed with only the original pod
    const dep = body.recent_completed.find((d: { deployment_id: string }) => d.deployment_id === "dep-auto3");
    expect(dep).toBeDefined();
    expect(dep.status).toBe("COMPLETED");
    expect(dep.groups.web.services).toHaveLength(1);
    expect(dep.groups.web.services[0].pod_name).toBe("svc-a-pod-1");
  });

  // --- /status tests ---

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

  it("GET /status shows ACTIVE when expected services are missing pods", async () => {
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-s1", service_id: "svc-a", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-s1", service_id: "svc-b", group: "web" },
    });
    // Only svc-a has a registered and ready pod
    await app.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-s1", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    await app.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-s1", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });

    const res = await app.inject({ method: "GET", url: "/status" });
    const body = res.json();

    expect(body.active).toHaveLength(1);
    expect(body.active[0].groups.web.missing_services).toContain("svc-b");
    expect(body.recent_completed).toHaveLength(0);
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

  it("POST /ready returns waiting when settle time has not elapsed", async () => {
    // Create a separate app with 9999s settle time
    const settleApp = Fastify();
    registerRoutes(settleApp, prisma, 9999, 300);
    await settleApp.ready();

    await settleApp.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-13", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });

    const res = await settleApp.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-13", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gate_status).toBe("waiting");
    expect(body.all_group_services_ready).toBe(true);
    expect(body.settle_time_remaining_seconds).toBeGreaterThan(0);

    await settleApp.close();
  });

  it("POST /ready returns waiting when expected services present and ready but settle time not elapsed", async () => {
    const settleApp = Fastify();
    registerRoutes(settleApp, prisma, 9999, 300);
    await settleApp.ready();

    // Webhook pre-registers expected services
    await settleApp.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-14", service_id: "svc-a", group: "web" },
    });
    await settleApp.inject({
      method: "POST",
      url: "/expect",
      payload: { deployment_id: "dep-14", service_id: "svc-b", group: "web" },
    });

    // Both sidecars register and report ready
    await settleApp.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-14", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "web" },
    });
    await settleApp.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-14", service_id: "svc-b", pod_name: "svc-b-pod-1", group: "web" },
    });
    await settleApp.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-14", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });
    const res = await settleApp.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-14", service_id: "svc-b", pod_name: "svc-b-pod-1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gate_status).toBe("waiting");
    expect(body.all_group_services_ready).toBe(true);
    expect(body.missing_services).toEqual([]);
    expect(body.settle_time_remaining_seconds).toBeGreaterThan(0);

    await settleApp.close();
  });

  it("POST /ready settle time is per-group — late registration in another group does not reset", async () => {
    const settleApp = Fastify();
    registerRoutes(settleApp, prisma, 2, 300); // 2s settle time
    await settleApp.ready();

    // Group A registers first
    await settleApp.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-15", service_id: "svc-a", pod_name: "svc-a-pod-1", group: "group-a" },
    });

    // Wait for settle time to pass for group A
    await new Promise((r) => setTimeout(r, 2100));

    // Group B registers late — should NOT reset group A's settle time
    await settleApp.inject({
      method: "POST",
      url: "/register",
      payload: { deployment_id: "dep-15", service_id: "svc-b", pod_name: "svc-b-pod-1", group: "group-b" },
    });

    // Group A should be open (settle time already passed for its pods)
    await settleApp.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-15", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });
    const resA = await settleApp.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-15", service_id: "svc-a", pod_name: "svc-a-pod-1" },
    });
    expect(resA.json().gate_status).toBe("open");

    // Group B should still be waiting (just registered, settle time not passed)
    const resB = await settleApp.inject({
      method: "POST",
      url: "/ready",
      payload: { deployment_id: "dep-15", service_id: "svc-b", pod_name: "svc-b-pod-1" },
    });
    expect(resB.json().gate_status).toBe("waiting");
    expect(resB.json().settle_time_remaining_seconds).toBeGreaterThan(0);

    await settleApp.close();
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
