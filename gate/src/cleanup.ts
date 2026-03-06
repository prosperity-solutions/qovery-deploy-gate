import { DeploymentStatus, PrismaClient } from "./generated/prisma/client.js";

interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export async function expireStaleDeployments(
  prisma: PrismaClient,
  ttlSeconds: number,
  log: Logger,
): Promise<number> {
  const cutoff = new Date(Date.now() - ttlSeconds * 1000);

  try {
    const result = await prisma.deployment.updateMany({
      where: {
        status: DeploymentStatus.ACTIVE,
        firstRegisteredAt: { lt: cutoff },
      },
      data: {
        status: DeploymentStatus.EXPIRED,
        completedAt: new Date(),
      },
    });

    if (result.count > 0) {
      log.info(`Expired ${result.count} stale deployment(s) older than ${ttlSeconds}s`);
    }

    return result.count;
  } catch (err) {
    log.error("Failed to expire stale deployments: %s", err);
    return 0;
  }
}
