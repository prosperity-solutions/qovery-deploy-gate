import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerWebhook } from "./webhook.js";

function buildApp(): FastifyInstance {
  // Plain HTTP Fastify instance for testing (no TLS)
  const app = Fastify({ logger: false });

  registerWebhook(app, {
    gateUrl: "http://localhost:9999",
    sidecarImage: "ghcr.io/test/sidecar:latest",
    pollInterval: "5",
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}

function makeAdmissionReview(labels: Record<string, string>, readinessGates?: { conditionType: string }[]) {
  const pod: Record<string, unknown> = {
    metadata: {
      name: "test-pod",
      namespace: "default",
      labels,
    },
    spec: {
      containers: [
        {
          name: "main",
          image: "nginx:latest",
        },
      ],
      ...(readinessGates ? { readinessGates } : {}),
    },
  };

  return {
    apiVersion: "admission.k8s.io/v1",
    kind: "AdmissionReview",
    request: {
      uid: "test-uid-1234",
      kind: { group: "", version: "v1", kind: "Pod" },
      resource: { group: "", version: "v1", resource: "pods" },
      object: pod,
    },
  };
}

describe("Mutating Admission Webhook", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should inject sidecar for pods with qovery-deploy-gate.life.li/group label", async () => {
    const body = makeAdmissionReview({
      "qovery-deploy-gate.life.li/group": "my-group",
      "qovery.com/deployment-id": "dep-123",
      "qovery.com/service-id": "svc-456",
    });

    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const review = JSON.parse(res.payload);
    expect(review.response.uid).toBe("test-uid-1234");
    expect(review.response.allowed).toBe(true);
    expect(review.response.patchType).toBe("JSONPatch");
    expect(review.response.patch).toBeDefined();

    // Decode and verify patch
    const patches = JSON.parse(Buffer.from(review.response.patch, "base64").toString());
    expect(Array.isArray(patches)).toBe(true);

    // Should have 2 patches: sidecar container + readiness gate
    expect(patches.length).toBe(2);

    // Sidecar container patch
    const containerPatch = patches.find(
      (p: { path: string }) => p.path === "/spec/containers/-"
    );
    expect(containerPatch).toBeDefined();
    expect(containerPatch.op).toBe("add");
    expect(containerPatch.value.name).toBe("gate-sidecar");
    expect(containerPatch.value.image).toBe("ghcr.io/test/sidecar:latest");

    // Verify env vars
    const envMap = new Map(
      containerPatch.value.env.map((e: { name: string; value?: string }) => [e.name, e.value])
    );
    expect(envMap.get("GATE_URL")).toBe("http://localhost:9999");
    expect(envMap.get("GATE_DEPLOYMENT_ID")).toBe("dep-123");
    expect(envMap.get("GATE_SERVICE_ID")).toBe("svc-456");
    expect(envMap.get("GATE_GROUP")).toBe("my-group");
    expect(envMap.get("GATE_POLL_INTERVAL")).toBe("5");

    // POD_NAME and POD_NAMESPACE use valueFrom
    const podNameEnv = containerPatch.value.env.find(
      (e: { name: string }) => e.name === "GATE_POD_NAME"
    );
    expect(podNameEnv.valueFrom.fieldRef.fieldPath).toBe("metadata.name");

    const podNsEnv = containerPatch.value.env.find(
      (e: { name: string }) => e.name === "GATE_POD_NAMESPACE"
    );
    expect(podNsEnv.valueFrom.fieldRef.fieldPath).toBe("metadata.namespace");

    // Readiness gate patch
    const gatePatch = patches.find(
      (p: { path: string }) => p.path === "/spec/readinessGates"
    );
    expect(gatePatch).toBeDefined();
    expect(gatePatch.op).toBe("add");
    expect(gatePatch.value).toEqual([{ conditionType: "qovery-deploy-gate.life.li/synced" }]);
  });

  it("should pass through pods without qovery-deploy-gate.life.li/group label", async () => {
    const body = makeAdmissionReview({
      app: "my-app",
    });

    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const review = JSON.parse(res.payload);
    expect(review.response.uid).toBe("test-uid-1234");
    expect(review.response.allowed).toBe(true);
    expect(review.response.patch).toBeUndefined();
    expect(review.response.patchType).toBeUndefined();
  });

  it("should skip injection when required Qovery labels are missing", async () => {
    const body = makeAdmissionReview({
      "qovery-deploy-gate.life.li/group": "my-group",
      // No qovery.com/deployment-id or qovery.com/service-id
    });

    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const review = JSON.parse(res.payload);
    expect(review.response.allowed).toBe(true);
    // No patch should be applied when required labels are missing
    expect(review.response.patch).toBeUndefined();
    expect(review.response.patchType).toBeUndefined();
  });

  it("should return correct JSON patch format", async () => {
    const body = makeAdmissionReview({
      "qovery-deploy-gate.life.li/group": "group-a",
      "qovery.com/deployment-id": "d1",
      "qovery.com/service-id": "s1",
    });

    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      payload: body,
    });

    const review = JSON.parse(res.payload);
    expect(review.apiVersion).toBe("admission.k8s.io/v1");
    expect(review.kind).toBe("AdmissionReview");
    expect(review.response.patchType).toBe("JSONPatch");

    // Verify base64-encoded patch is valid JSON
    const decoded = Buffer.from(review.response.patch, "base64").toString();
    const patches = JSON.parse(decoded);
    expect(Array.isArray(patches)).toBe(true);

    // Every patch should have op and path
    for (const patch of patches) {
      expect(patch.op).toBeDefined();
      expect(patch.path).toBeDefined();
    }
  });

  it("should append to existing readinessGates", async () => {
    const body = makeAdmissionReview(
      {
        "qovery-deploy-gate.life.li/group": "group-b",
        "qovery.com/deployment-id": "d2",
        "qovery.com/service-id": "s2",
      },
      [{ conditionType: "some-other-gate" }]
    );

    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const review = JSON.parse(res.payload);
    const patches = JSON.parse(Buffer.from(review.response.patch, "base64").toString());

    // Readiness gate should be appended (using /- path) not replaced
    const gatePatch = patches.find(
      (p: { path: string }) =>
        p.path === "/spec/readinessGates/-"
    );
    expect(gatePatch).toBeDefined();
    expect(gatePatch.op).toBe("add");
    expect(gatePatch.value).toEqual({ conditionType: "qovery-deploy-gate.life.li/synced" });
  });

  it("should still inject sidecar on dry-run but skip registration", async () => {
    const review = makeAdmissionReview({
      "qovery-deploy-gate.life.li/group": "my-group",
      "qovery.com/deployment-id": "dep-dry",
      "qovery.com/service-id": "svc-dry",
    });
    // Add dryRun flag
    (review.request as Record<string, unknown>).dryRun = true;

    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      payload: review,
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    expect(result.response.allowed).toBe(true);
    // Should still return a patch (sidecar injection) even on dry-run
    expect(result.response.patch).toBeDefined();
    expect(result.response.patchType).toBe("JSONPatch");
  });

  it("healthz should return 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe("ok");
  });
});
