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

interface Volume {
  name: string;
  projected?: {
    sources: { serviceAccountToken?: { path: string; expirationSeconds?: number }; configMap?: { name: string; items?: { key: string; path: string }[] } }[];
  };
  [key: string]: unknown;
}

interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
}

interface PodSpec {
  containers?: Container[];
  readinessGates?: ReadinessGate[];
  volumes?: Volume[];
  automountServiceAccountToken?: boolean;
  [key: string]: unknown;
}

interface Container {
  name: string;
  image: string;
  env?: EnvVar[];
  volumeMounts?: VolumeMount[];
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
    volumeMounts: [
      {
        name: "gate-sidecar-sa-token",
        mountPath: "/var/run/secrets/gate-sidecar/serviceaccount",
        readOnly: true,
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
  const containers = pod.spec?.containers;

  // Guard: skip injection if sidecar already present (e.g., webhook reinvocation)
  if (containers?.some((c) => c.name === "gate-sidecar")) {
    return patches;
  }

  // Add sidecar to containers array (containers always exists per k8s spec)
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

  // Inject a projected volume with the service account token and CA cert,
  // mounted only into the gate-sidecar container. This avoids flipping
  // automountServiceAccountToken pod-wide, so the application containers
  // are not affected even when the platform disables token mounting.
  const saVolume: Volume = {
    name: "gate-sidecar-sa-token",
    projected: {
      sources: [
        {
          serviceAccountToken: {
            path: "token",
            expirationSeconds: 3600,
          },
        },
        {
          configMap: {
            name: "kube-root-ca.crt",
            items: [{ key: "ca.crt", path: "ca.crt" }],
          },
        },
      ],
    },
  };

  const existingVolumes = pod.spec?.volumes;
  const volumeExists = existingVolumes?.some((v) => v.name === saVolume.name);
  if (!volumeExists) {
    if (existingVolumes && existingVolumes.length > 0) {
      patches.push({
        op: "add",
        path: "/spec/volumes/-",
        value: saVolume,
      });
    } else {
      patches.push({
        op: "add",
        path: "/spec/volumes",
        value: [saVolume],
      });
    }
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

function fireAndForgetExpect(
  gateUrl: string,
  deploymentId: string,
  serviceId: string,
  group: string,
  log: { warn: (msg: string) => void }
): void {
  const body = JSON.stringify({
    deployment_id: deploymentId,
    service_id: serviceId,
    group,
  });

  const attempt = (n: number): Promise<void> =>
    fetch(`${gateUrl}/expect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    }).then(async (res) => {
      await res.body?.cancel();
      if (!res.ok) {
        if (n < 3) {
          return new Promise<void>((r) => setTimeout(r, 500 * n)).then(() => attempt(n + 1));
        }
        log.warn(`Failed to pre-register expected service ${serviceId} after 3 attempts: HTTP ${res.status}`);
      }
    }).catch((err) => {
      if (n < 3) {
        return new Promise<void>((r) => setTimeout(r, 500 * n)).then(() => attempt(n + 1));
      }
      log.warn(`Failed to pre-register expected service ${serviceId} after 3 attempts: ${err.message}`);
    });

  attempt(1).catch(() => {});
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

    // Pre-register the expected service with the gate (fire-and-forget).
    // This tells the gate "this service ID must appear before the group can open."
    // At admission time the actual pod name isn't available (only generateName),
    // so we only declare the service — the sidecar registers pods with real names later.
    if (!req.dryRun) {
      fireAndForgetExpect(config.gateUrl, deploymentId, serviceId, group, request.log);
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
