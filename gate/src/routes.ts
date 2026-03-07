import { FastifyInstance } from "fastify";
import { PrismaClient } from "./generated/prisma/client.js";

interface ExpectBody {
  deployment_id: string;
  service_id: string;
  group: string;
}

interface RegisterBody {
  deployment_id: string;
  service_id: string;
  pod_name: string;
  namespace?: string;
  group: string;
}

interface ReadyBody {
  deployment_id: string;
  service_id: string;
  pod_name: string;
  namespace?: string;
}

function isStale(lastPingedAt: Date, staleTimeout: number): boolean {
  return Date.now() - lastPingedAt.getTime() > staleTimeout * 1000;
}

export function registerRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  minSettleTime: number,
  staleTimeout: number = 300
) {
  // Liveness probe - no DB access
  app.get("/healthz", async (_request, reply) => {
    return reply.status(200).send({ status: "ok" });
  });

  // Readiness probe - verifies DB connectivity
  app.get("/readyz", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.status(200).send({ status: "ok" });
    } catch {
      return reply.status(503).send({ status: "unavailable" });
    }
  });

  // Pre-register an expected service (called by webhook at admission time)
  app.post<{ Body: ExpectBody }>("/expect", {
    schema: {
      body: {
        type: "object",
        required: ["deployment_id", "service_id", "group"],
        additionalProperties: false,
        properties: {
          deployment_id: { type: "string", minLength: 1, maxLength: 255 },
          service_id: { type: "string", minLength: 1, maxLength: 255 },
          group: { type: "string", minLength: 1, maxLength: 255 },
        },
      },
    },
  }, async (request, reply) => {
    const { deployment_id, service_id, group } = request.body;

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.deployment.upsert({
        where: { deploymentId: deployment_id },
        create: {
          deploymentId: deployment_id,
          firstRegisteredAt: now,
          lastRegisteredAt: now,
          lastPingedAt: now,
        },
        // Refresh lastPingedAt on subsequent /expect calls to prevent premature
        // expiry when services are admitted over an extended period (node scaling)
        update: { lastPingedAt: now },
      });

      const existing = await tx.expectedService.findUnique({
        where: {
          deploymentId_serviceId: {
            deploymentId: deployment_id,
            serviceId: service_id,
          },
        },
      });

      if (existing) {
        return { created: false, expected: existing };
      }

      // Use upsert instead of create to handle concurrent /expect calls
      // for the same service — the unique constraint would reject a plain create
      const expected = await tx.expectedService.upsert({
        where: {
          deploymentId_serviceId: {
            deploymentId: deployment_id,
            serviceId: service_id,
          },
        },
        create: {
          deploymentId: deployment_id,
          serviceId: service_id,
          groupName: group,
        },
        update: {},
      });

      return { created: true, expected };
    });

    const statusCode = result.created ? 201 : 200;
    return reply.status(statusCode).send({
      deployment_id,
      service_id,
      group,
      already_expected: !result.created,
    });
  });

  // Register a pod for a deployment (called by sidecar on startup)
  app.post<{ Body: RegisterBody }>("/register", {
    schema: {
      body: {
        type: "object",
        required: ["deployment_id", "service_id", "pod_name", "group"],
        additionalProperties: false,
        properties: {
          deployment_id: { type: "string", minLength: 1, maxLength: 255 },
          service_id: { type: "string", minLength: 1, maxLength: 255 },
          pod_name: { type: "string", minLength: 1, maxLength: 255 },
          namespace: { type: "string", maxLength: 255 },
          group: { type: "string", minLength: 1, maxLength: 255 },
        },
      },
    },
  }, async (request, reply) => {
    const { deployment_id, service_id, pod_name, namespace, group } = request.body;

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.deployment.upsert({
        where: { deploymentId: deployment_id },
        create: {
          deploymentId: deployment_id,
          firstRegisteredAt: now,
          lastRegisteredAt: now,
          lastPingedAt: now,
        },
        update: {},
      });

      // Upsert the pod registration (idempotent, safe under concurrent requests)
      const ns = namespace ?? "";
      const existingBefore = await tx.deploymentService.findUnique({
        where: {
          deploymentId_serviceId_podName_namespace: {
            deploymentId: deployment_id,
            serviceId: service_id,
            podName: pod_name,
            namespace: ns,
          },
        },
      });

      const service = await tx.deploymentService.upsert({
        where: {
          deploymentId_serviceId_podName_namespace: {
            deploymentId: deployment_id,
            serviceId: service_id,
            podName: pod_name,
            namespace: ns,
          },
        },
        create: {
          deploymentId: deployment_id,
          serviceId: service_id,
          podName: pod_name,
          namespace: ns,
          groupName: group,
        },
        update: { groupName: group },
      });

      if (!existingBefore) {
        // Update lastRegisteredAt (resets settle timer) and lastPingedAt (prevents
        // early expiry if /expect was called long before node provisioning completed)
        await tx.deployment.update({
          where: { deploymentId: deployment_id },
          data: { lastRegisteredAt: now, lastPingedAt: now },
        });

        // Belt-and-suspenders: also upsert the expected service record.
        // If the webhook's fire-and-forget /expect call failed, this ensures the
        // gate still knows about this service. On conflict, update groupName to
        // match the sidecar's actual group (corrects any mismatch from /expect).
        await tx.expectedService.upsert({
          where: {
            deploymentId_serviceId: {
              deploymentId: deployment_id,
              serviceId: service_id,
            },
          },
          create: {
            deploymentId: deployment_id,
            serviceId: service_id,
            groupName: group,
          },
          update: { groupName: group },
        });
      }

      // Even on idempotent calls, refresh lastPingedAt to prevent expiry
      // during sidecar retry loops where the pod re-registers repeatedly
      if (existingBefore) {
        await tx.deployment.update({
          where: { deploymentId: deployment_id },
          data: { lastPingedAt: now },
        });
      }

      return { created: !existingBefore, service };
    });

    const statusCode = result.created ? 201 : 200;
    return reply.status(statusCode).send({
      deployment_id,
      service_id,
      pod_name,
      group,
      registered_at: result.service.registeredAt.toISOString(),
      already_registered: !result.created,
    });
  });

  // Mark a pod as ready and check gate status
  app.post<{ Body: ReadyBody }>("/ready", {
    schema: {
      body: {
        type: "object",
        required: ["deployment_id", "service_id", "pod_name"],
        additionalProperties: false,
        properties: {
          deployment_id: { type: "string", minLength: 1, maxLength: 255 },
          service_id: { type: "string", minLength: 1, maxLength: 255 },
          pod_name: { type: "string", minLength: 1, maxLength: 255 },
          namespace: { type: "string", maxLength: 255 },
        },
      },
    },
  }, async (request, reply) => {
    const { deployment_id, service_id, pod_name, namespace } = request.body;

    const result = await prisma.$transaction(async (tx) => {
      const deployment = await tx.deployment.findUnique({
        where: { deploymentId: deployment_id },
      });

      if (!deployment) {
        return { gate_status: "not_found" as const, reason: `Unknown deployment: ${deployment_id}` };
      }

      // Stale deployment — gate opens without refreshing lastPingedAt
      if (isStale(deployment.lastPingedAt, staleTimeout)) {
        return { gate_status: "open" as const, message: "Deployment expired" };
      }

      // Update last pinged timestamp
      await tx.deployment.update({
        where: { id: deployment.id },
        data: { lastPingedAt: new Date() },
      });

      const service = await tx.deploymentService.findUnique({
        where: {
          deploymentId_serviceId_podName_namespace: {
            deploymentId: deployment_id,
            serviceId: service_id,
            podName: pod_name,
            namespace: namespace ?? "",
          },
        },
      });

      if (!service) {
        return { gate_status: "not_found" as const, reason: `Pod ${pod_name} (service ${service_id}) is not registered for deployment ${deployment_id}` };
      }

      // Mark the pod as ready if not already
      if (!service.readyAt) {
        await tx.deploymentService.update({
          where: { id: service.id },
          data: { readyAt: new Date() },
        });
      }

      // Check if all pods in the same group are ready
      const groupServices = await tx.deploymentService.findMany({
        where: {
          deploymentId: deployment_id,
          groupName: service.groupName,
        },
      });

      const pendingPods = groupServices.filter((s) => {
        if (s.id === service.id) return false;
        return s.readyAt === null;
      });

      const allPodsReady = pendingPods.length === 0;

      // Check if all expected services for this group have at least one registered pod
      const expectedServices = await tx.expectedService.findMany({
        where: {
          deploymentId: deployment_id,
          groupName: service.groupName,
        },
      });

      const registeredServiceIds = new Set(groupServices.map((s) => s.serviceId));
      const missingServices = expectedServices.filter(
        (es) => !registeredServiceIds.has(es.serviceId)
      );

      const allExpectedPresent = missingServices.length === 0;

      // Check settle time (from last pod registration, not first)
      const elapsedMs = Date.now() - deployment.lastRegisteredAt.getTime();
      const settleTimeMs = minSettleTime * 1000;
      const settleTimeMet = elapsedMs >= settleTimeMs;
      const settleTimeRemainingMs = settleTimeMet ? 0 : settleTimeMs - elapsedMs;
      const settleTimeRemainingSeconds = Math.ceil(settleTimeRemainingMs / 1000);

      if (allPodsReady && allExpectedPresent && settleTimeMet) {
        return {
          gate_status: "open" as const,
          group: service.groupName,
          group_services_total: groupServices.length,
          group_services_ready: groupServices.length,
        };
      }

      return {
        gate_status: "waiting" as const,
        group: service.groupName,
        group_services_total: groupServices.length,
        group_services_ready: groupServices.length - pendingPods.length,
        pending_services: pendingPods.map((s) => `${s.serviceId}/${s.podName}`),
        pending_pods: pendingPods.map((s) => `${s.serviceId}/${s.podName}`),
        missing_services: missingServices.map((es) => es.serviceId),
        settle_time_remaining_seconds: (allPodsReady && allExpectedPresent) ? settleTimeRemainingSeconds : undefined,
        all_group_services_ready: allPodsReady && allExpectedPresent,
      };
    });

    if (result.gate_status === "not_found") {
      return reply.status(404).send({
        gate_status: "error",
        error_code: "not_found",
        reason: result.reason,
      });
    }

    return reply.status(200).send({
      ...result,
      deployment_id,
      service_id,
      pod_name,
    });
  });

  // Get status of all deployments
  app.get("/status", async (_request, reply) => {
    // Only show deployments from the last 24 hours
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const deployments = await prisma.deployment.findMany({
      where: { createdAt: { gt: cutoff } },
      include: { services: true, expectedServices: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const formatDeployment = (d: typeof deployments[number]) => {
      const groups: Record<
        string,
        {
          total: number;
          ready: number;
          expected: number;
          missing_services: string[];
          services: { service_id: string; pod_name: string; namespace: string; ready: boolean; ready_at: string | null }[];
        }
      > = {};

      for (const svc of d.services) {
        if (!groups[svc.groupName]) {
          groups[svc.groupName] = { total: 0, ready: 0, expected: 0, missing_services: [], services: [] };
        }
        groups[svc.groupName].total++;
        if (svc.readyAt) groups[svc.groupName].ready++;
        groups[svc.groupName].services.push({
          service_id: svc.serviceId,
          pod_name: svc.podName,
          namespace: svc.namespace,
          ready: svc.readyAt !== null,
          ready_at: svc.readyAt?.toISOString() ?? null,
        });
      }

      // Add expected service info per group
      // Build per-group registered service ID sets once
      const groupRegisteredIds: Record<string, Set<string>> = {};
      for (const groupName of Object.keys(groups)) {
        groupRegisteredIds[groupName] = new Set(groups[groupName].services.map((s) => s.service_id));
      }

      for (const es of d.expectedServices) {
        if (!groups[es.groupName]) {
          groups[es.groupName] = { total: 0, ready: 0, expected: 0, missing_services: [], services: [] };
          groupRegisteredIds[es.groupName] = new Set();
        }
        groups[es.groupName].expected++;
        if (!groupRegisteredIds[es.groupName].has(es.serviceId)) {
          groups[es.groupName].missing_services.push(es.serviceId);
        }
      }

      // Derive status entirely from data
      const allReady = d.services.length > 0 && d.services.every((s) => s.readyAt !== null);
      // Check expected services per-group (consistent with /ready logic)
      const allExpectedPresent = Object.values(groups).every((g) => g.missing_services.length === 0);

      let derivedStatus: "COMPLETED" | "EXPIRED" | "ACTIVE";
      if (allReady && allExpectedPresent) {
        derivedStatus = "COMPLETED";
      } else if (isStale(d.lastPingedAt, staleTimeout)) {
        derivedStatus = "EXPIRED";
      } else {
        derivedStatus = "ACTIVE";
      }

      return {
        deployment_id: d.deploymentId,
        status: derivedStatus,
        first_registered_at: d.firstRegisteredAt.toISOString(),
        groups,
      };
    };

    const formatted = deployments.map(formatDeployment);

    return reply.status(200).send({
      active: formatted.filter((d) => d.status === "ACTIVE"),
      recent_completed: formatted.filter((d) => d.status === "COMPLETED"),
      recent_expired: formatted.filter((d) => d.status === "EXPIRED"),
    });
  });
}
