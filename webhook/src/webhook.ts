import type { FastifyInstance } from "fastify";

// ---- Kubernetes AdmissionReview v1 types ----

interface AdmissionReviewRequest {
  uid: string;
  kind: { group: string; version: string; kind: string };
  resource: { group: string; version: string; resource: string };
  object: PodObject;
  oldObject?: PodObject;
  dryRun?: boolean;
}

interface PodObject {
  metadata?: {
    name?: string;
    generateName?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: PodSpec;
}

interface PodSpec {
  containers?: Container[];
  readinessGates?: ReadinessGate[];
  automountServiceAccountToken?: boolean;
  [key: string]: unknown;
}

interface Container {
  name: string;
  image: string;
  env?: EnvVar[];
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  [key: string]: unknown;
}

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    fieldRef?: { fieldPath: string };
    [key: string]: unknown;
  };
}

interface ReadinessGate {
  conditionType: string;
}

interface AdmissionReview {
  apiVersion: string;
  kind: string;
  request?: AdmissionReviewRequest;
}

interface JsonPatchOp {
  op: "add" | "replace" | "remove" | "copy" | "move" | "test";
  path: string;
  value?: unknown;
}

// ---- Configuration ----

export interface WebhookConfig {
  gateUrl: string;
  sidecarImage: string;
  pollInterval: string;
}

// ---- Helpers ----

function buildSidecarContainer(
  config: WebhookConfig,
  labels: Record<string, string>
): Container {
  const deploymentId = labels["qovery.com/deployment-id"] || "";
  const serviceId = labels["qovery.com/service-id"] || "";
  const group = labels["qovery-deploy-gate.life.li/group"] || "";

  return {
    name: "gate-sidecar",
    image: config.sidecarImage,
    env: [
      { name: "GATE_URL", value: config.gateUrl },
      { name: "GATE_DEPLOYMENT_ID", value: deploymentId },
      { name: "GATE_SERVICE_ID", value: serviceId },
      { name: "GATE_GROUP", value: group },
      { name: "GATE_POLL_INTERVAL", value: config.pollInterval },
      {
        name: "GATE_POD_NAME",
        valueFrom: { fieldRef: { fieldPath: "metadata.name" } },
      },
      {
        name: "GATE_POD_NAMESPACE",
        valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } },
      },
    ],
    resources: {
      requests: { cpu: "10m", memory: "16Mi" },
      limits: { cpu: "50m", memory: "32Mi" },
    },
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 65534,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    },
  };
}

function buildJsonPatch(
  pod: PodObject,
  sidecar: Container
): JsonPatchOp[] {
  const patches: JsonPatchOp[] = [];

  // Add sidecar to containers array (containers always exists per k8s spec)
  const containers = pod.spec?.containers;
  if (containers && containers.length > 0) {
    patches.push({
      op: "add",
      path: "/spec/containers/-",
      value: sidecar,
    });
  } else {
    // Edge case: empty or missing containers — create the array with the sidecar
    patches.push({
      op: "add",
      path: "/spec/containers",
      value: [sidecar],
    });
  }

  // Ensure service account token is mounted (sidecar needs K8s API access to patch
  // pod readiness conditions). This is a pod-level setting, so all containers in the
  // pod will have access to the token. The token is scoped to the pod's service account
  // which our RBAC limits to pods/get and pods/status/patch.
  // If this is a concern, a future improvement could use a projected volume to mount
  // the token only into the gate-sidecar container.
  if (pod.spec?.automountServiceAccountToken === false) {
    patches.push({
      op: "replace",
      path: "/spec/automountServiceAccountToken",
      value: true,
    });
  }

  // Add readiness gate
  const readinessGate: ReadinessGate = {
    conditionType: "qovery-deploy-gate.life.li/synced",
  };

  const existingGates = pod.spec?.readinessGates;
  if (existingGates && existingGates.length > 0) {
    // Append to existing array
    patches.push({
      op: "add",
      path: "/spec/readinessGates/-",
      value: readinessGate,
    });
  } else {
    // Create the array
    patches.push({
      op: "add",
      path: "/spec/readinessGates",
      value: [readinessGate],
    });
  }

  return patches;
}

async function fireAndForgetRegister(
  gateUrl: string,
  labels: Record<string, string>,
  podMeta: { name: string; namespace: string },
  logger: { error: (msg: string, ...args: unknown[]) => void }
): Promise<void> {
  const deploymentId = labels["qovery.com/deployment-id"] || "";
  const serviceId = labels["qovery.com/service-id"] || "";
  const group = labels["qovery-deploy-gate.life.li/group"] || "";

  try {
    const response = await fetch(`${gateUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deployment_id: deploymentId,
        service_id: serviceId,
        pod_name: podMeta.name,
        namespace: podMeta.namespace,
        group,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.error(
        "Failed to register with gate: %s %s",
        response.status,
        response.statusText
      );
    }
  } catch (err) {
    logger.error("Error registering with gate: %s", err);
  }
}

// ---- Route registration ----

export function registerWebhook(
  app: FastifyInstance,
  config: WebhookConfig
): void {
  app.post("/mutate", async (request) => {
    const admissionReview = request.body as AdmissionReview;
    const req = admissionReview.request;

    if (!req) {
      request.log.warn("Invalid AdmissionReview: missing request");
      return {
        apiVersion: "admission.k8s.io/v1",
        kind: "AdmissionReview",
        response: {
          uid: "",
          allowed: true,
        },
      };
    }

    const pod = req.object;
    const labels = pod.metadata?.labels || {};
    const group = labels["qovery-deploy-gate.life.li/group"];

    // If the pod does not have the qovery-deploy-gate.life.li/group label, allow without mutation
    if (!group) {
      return {
        apiVersion: "admission.k8s.io/v1",
        kind: "AdmissionReview",
        response: {
          uid: req.uid,
          allowed: true,
        },
      };
    }

    // Validate required Qovery labels
    const deploymentId = labels["qovery.com/deployment-id"];
    const serviceId = labels["qovery.com/service-id"];
    if (!deploymentId || !serviceId) {
      request.log.warn(
        "Pod has group label but missing required Qovery labels (qovery.com/deployment-id, qovery.com/service-id), skipping injection"
      );
      return {
        apiVersion: "admission.k8s.io/v1",
        kind: "AdmissionReview",
        response: {
          uid: req.uid,
          allowed: true,
        },
      };
    }

    // Build sidecar and JSON patch
    const sidecar = buildSidecarContainer(config, labels);
    const patches = buildJsonPatch(pod, sidecar);
    const patchBase64 = Buffer.from(JSON.stringify(patches)).toString("base64");

    // Fire-and-forget registration with the gate service (skip on dry-run)
    // Pod name may be empty at admission time (generateName), sidecar will re-register with actual name
    if (!req.dryRun) {
      const podMeta = {
        name: pod.metadata?.name || pod.metadata?.generateName || "",
        namespace: pod.metadata?.namespace || "",
      };
      fireAndForgetRegister(config.gateUrl, labels, podMeta, request.log).catch(() => {
        // Swallow — already logged inside the function
      });
    }

    return {
      apiVersion: "admission.k8s.io/v1",
      kind: "AdmissionReview",
      response: {
        uid: req.uid,
        allowed: true,
        patchType: "JSONPatch",
        patch: patchBase64,
      },
    };
  });
}
