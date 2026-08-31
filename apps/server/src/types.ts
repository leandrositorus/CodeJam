export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type UserRole = "admin" | "user";
export type AuthorizationStatus = "active" | "disabled";
export type AuthorizationAction = "read" | "write";
export type PolicyStatus = "active" | "revoked" | "superseded";
export type DecisionResult = "allow" | "deny";

export interface Agent {
  id: string;
  ownerId: string;
  authorizationStatus: AuthorizationStatus;
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

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedActor extends PublicUser {}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  initiatingUserId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface UserAuthorizationPolicy {
  id: string;
  ownerId: string;
  sourceText: string;
  status: PolicyStatus;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProtectedResource {
  id: string;
  ownerId: string;
  category: string;
  label: string;
  sourceAgentId: string | null;
  description: string;
  sharingEligible: boolean;
  offerDescriptor: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorizationDecision {
  id: string;
  timestamp: string;
  runId: string;
  initiatingUserId: string;
  agentId: string;
  action: AuthorizationAction;
  resourceId: string;
  resourceLabel: string | null;
  policyId: string | null;
  legacyTemplateId: string | null;
  result: DecisionResult;
  reasonCode: string;
  executionResult: "not_attempted" | "succeeded" | "failed";
}

export interface AuthorizationLifecycleEvent {
  id: string;
  timestamp: string;
  actorId: string;
  eventType: "policy_activated" | "policy_superseded" | "policy_revoked" | "agent_authorization_changed" | "offer_created" | "offer_accepted" | "offer_rejected" | "offer_cancelled" | "grant_revoked";
  policyId: string | null;
  legacyTemplateId: string | null;
  agentId: string | null;
}

export type OfferStatus = "pending" | "accepted" | "rejected" | "cancelled";
export type GrantStatus = "active" | "revoked";
export interface AccessOffer {
  id: string; resourceOwnerId: string; resourceId: string; recipientOwnerId: string; recipientAgentId: string;
  action: "read"; descriptor: string; expiresAt: string; version: number; status: OfferStatus;
  offeredAt: string; acceptedAt: string | null; rejectedAt: string | null; cancelledAt: string | null;
}
export interface CrossOwnerGrant {
  id: string; offerId: string; offerVersion: number; resourceOwnerId: string; recipientOwnerId: string; recipientAgentId: string; resourceId: string;
  action: "read"; issuedAt: string; expiresAt: string; status: GrantStatus; revokedAt: string | null;
}

export interface Database {
  version: 9;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  users: User[];
  sessions: Session[];
  authorizationPolicies: UserAuthorizationPolicy[];
  protectedResources: ProtectedResource[];
  authorizationDecisions: AuthorizationDecision[];
  authorizationLifecycleEvents: AuthorizationLifecycleEvent[];
  accessOffers: AccessOffer[];
  crossOwnerGrants: CrossOwnerGrant[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  codexHomePath: string;
  prompt: string;
  threadId: string | null;
  authorization?: { socketPath?: string; endpoint?: { host: string; port: number }; credentialPath: string; resources: Array<Pick<ProtectedResource, "id" | "label" | "category" | "offerDescriptor">> };
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
