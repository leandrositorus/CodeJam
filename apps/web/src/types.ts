export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  ownerId: string;
  authorizationStatus: "active" | "disabled";
  sharingEligible: boolean;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorizationPolicy { id: string; sourceText: string; status: "active" | "revoked" | "superseded"; revokedAt: string | null; createdAt: string; updatedAt: string; }
export interface ProtectedResource { id: string; ownerId: string; category: string; label: string; sharingEligible: boolean; offerDescriptor: string; createdAt: string; updatedAt: string; }
export interface ProtectedResourceDetail extends ProtectedResource { sourceAgentId: string | null; description: string; }
export interface AuthorizationDecision { id: string; timestamp: string; runId: string; agentId: string; action: "read" | "write"; resourceLabel: string | null; result: "allow" | "deny"; reasonCode: string; }
export interface SharingAgent { id: string; name: string; ownerId: string; }
export interface AccessOffer { id: string; resourceOwnerId: string; resourceId: string; recipientOwnerId: string; recipientAgentId: string; action: "read"; descriptor: string; expiresAt: string; version: number; status: "pending" | "accepted" | "rejected" | "cancelled"; offeredAt: string; resourceCategory?: string | null; recipientAgentName?: string | null; }
export interface CrossOwnerGrant { id: string; offerId: string; offerVersion: number; resourceOwnerId: string; recipientOwnerId: string; recipientAgentId: string; resourceId: string; action: "read"; issuedAt: string; expiresAt: string; status: "active" | "revoked"; revokedAt: string | null; }

export interface User {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
  passportBridgeReady: boolean;
  crossOwnerSharingEnabled: boolean;
  storyMatchingEnabled: boolean;
  storyMatchingAvailable: boolean;
}
