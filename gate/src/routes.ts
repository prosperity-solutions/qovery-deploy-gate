import { FastifyInstance } from "fastify";
import { DeploymentStatus, PrismaClient } from "@prisma/client";

interface RegisterBody {
  deployment_id: string;
  service_id: string;
  group: string;
}

interface ReadyBody {
  deployment_id: string;
  service_id: string;
}

export function registerRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  minSettleTime: number
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

  // Register a service for a deployment
  app.post<{ Body: RegisterBody }>("/register", {
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
      // Upsert the deployment record
      await tx.deployment.upsert({
        where: { deploymentId: deployment_id },
        create: {
          deploymentId: deployment_id,
          status: DeploymentStatus.ACTIVE,
          firstRegisteredAt: new Date(),
        },
        update: {},
      });

      // Try to create the service registration (idempotent)
      const existing = await tx.deploymentService.findUnique({
        where: {
          deploymentId_serviceId: {
            deploymentId: deployment_id,
            serviceId: service_id,
          },
        },
      });

      if (existing) {
        return { created: false, service: existing };
      }

      const service = await tx.deploymentService.create({
        data: {
          deploymentId: deployment_id,
          serviceId: service_id,
          groupName: group,
        },
      });

      return { created: true, service };
    });

    const statusCode = result.created ? 201 : 200;
    return reply.status(statusCode).send({
      deployment_id,
      service_id,
      group,
      registered_at: result.service.registeredAt.toISOString(),
      already_registered: !result.created,
    });
  });

  // Mark a service as ready and check gate status
  app.post<{ Body: ReadyBody }>("/ready", {
    schema: {
      body: {
        type: "object",
        required: ["deployment_id", "service_id"],
        additionalProperties: false,
        properties: {
          deployment_id: { type: "string", minLength: 1, maxLength: 255 },
          service_id: { type: "string", minLength: 1, maxLength: 255 },
        },
      },
    },
  }, async (request, reply) => {
    const { deployment_id, service_id } = request.body;

    // Check for already-completed deployment outside transaction (fast path)
    const deploymentCheck = await prisma.deployment.findUnique({
      where: { deploymentId: deployment_id },
    });

    if (!deploymentCheck) {
      return reply.status(404).send({
        gate_status: "error",
        reason: `Unknown deployment: ${deployment_id}`,
      });
    }

    if (deploymentCheck.status === DeploymentStatus.COMPLETED) {
      return reply.status(200).send({
        gate_status: "open",
        deployment_id,
        service_id,
        message: "Deployment already completed",
      });
    }

    // All state mutations and group evaluation in a single transaction
    const result = await prisma.$transaction(async (tx) => {
      const deployment = await tx.deployment.findUnique({
        where: { deploymentId: deployment_id },
      });

      if (!deployment || deployment.status === DeploymentStatus.COMPLETED) {
        return { gate_status: "open" as const, message: "Deployment already completed" };
      }

      const service = await tx.deploymentService.findUnique({
        where: {
          deploymentId_serviceId: {
            deploymentId: deployment_id,
            serviceId: service_id,
          },
        },
      });

      if (!service) {
        return { gate_status: "not_found" as const, reason: `Service ${service_id} is not registered for deployment ${deployment_id}` };
      }

      // Mark the service as ready if not already
      if (!service.readyAt) {
        await tx.deploymentService.update({
          where: { id: service.id },
          data: { readyAt: new Date() },
        });
      }

      // Check if all services in the same group are ready
      const groupServices = await tx.deploymentService.findMany({
        where: {
          deploymentId: deployment_id,
          groupName: service.groupName,
        },
      });

      const pendingServices = groupServices.filter((s) => {
        if (s.id === service.id) return false;
        return s.readyAt === null;
      });

      const allGroupReady = pendingServices.length === 0;

      // Check settle time
      const elapsedMs = Date.now() - deployment.firstRegisteredAt.getTime();
      const settleTimeMs = minSettleTime * 1000;
      const settleTimeMet = elapsedMs >= settleTimeMs;
      const settleTimeRemainingMs = settleTimeMet ? 0 : settleTimeMs - elapsedMs;
      const settleTimeRemainingSeconds = Math.ceil(settleTimeRemainingMs / 1000);

      if (allGroupReady && settleTimeMet) {
        // Check if ALL groups for this deployment are complete
        const allServices = await tx.deploymentService.findMany({
          where: { deploymentId: deployment_id },
        });

        const allReady = allServices.every((s) => {
          if (s.id === service.id) return true;
          return s.readyAt !== null;
        });

        if (allReady) {
          await tx.deployment.update({
            where: { deploymentId: deployment_id, status: DeploymentStatus.ACTIVE },
            data: { status: DeploymentStatus.COMPLETED, completedAt: new Date() },
          });
        }

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
        group_services_ready: groupServices.length - pendingServices.length,
        pending_services: pendingServices.map((s) => s.serviceId),
        settle_time_remaining_seconds: allGroupReady ? settleTimeRemainingSeconds : undefined,
        all_group_services_ready: allGroupReady,
      };
    });

    if (result.gate_status === "not_found") {
      return reply.status(404).send({
        gate_status: "error",
        reason: result.reason,
      });
    }

    return reply.status(200).send({
      ...result,
      deployment_id,
      service_id,
    });
  });

  // Get status of all deployments
  app.get("/status", async (_request, reply) => {
    const activeDeployments = await prisma.deployment.findMany({
      where: { status: DeploymentStatus.ACTIVE },
      include: { services: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const recentCompleted = await prisma.deployment.findMany({
      where: { status: DeploymentStatus.COMPLETED },
      include: { services: true },
      orderBy: { completedAt: "desc" },
      take: 20,
    });

    const formatDeployment = (d: typeof activeDeployments[number]) => {
      // Group services by group name
      const groups: Record<
        string,
        { total: number; ready: number; services: { service_id: string; ready: boolean; ready_at: string | null }[] }
      > = {};

      for (const svc of d.services) {
        if (!groups[svc.groupName]) {
          groups[svc.groupName] = { total: 0, ready: 0, services: [] };
        }
        groups[svc.groupName].total++;
        if (svc.readyAt) groups[svc.groupName].ready++;
        groups[svc.groupName].services.push({
          service_id: svc.serviceId,
          ready: svc.readyAt !== null,
          ready_at: svc.readyAt?.toISOString() ?? null,
        });
      }

      return {
        deployment_id: d.deploymentId,
        status: d.status,
        first_registered_at: d.firstRegisteredAt.toISOString(),
        completed_at: d.completedAt?.toISOString() ?? null,
        groups,
      };
    };

    return reply.status(200).send({
      active: activeDeployments.map(formatDeployment),
      recent_completed: recentCompleted.map(formatDeployment),
    });
  });
}
