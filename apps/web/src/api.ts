import type { Agent, AgentRun, Message, SystemInfo, User, AuthorizationPolicy, AuthorizationDecision, ProtectedResource, ProtectedResourceDetail } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  login: (username: string, password: string) =>
    request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  session: () => request<{ user: User }>("/api/auth/session"),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  listUsers: () => request<{ users: User[] }>("/api/users"),
  createUser: (username: string, password: string) =>
    request<{ user: User }>("/api/users", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  resetUserPassword: (id: string, password: string) =>
    request<{ user: User }>("/api/users/" + id + "/password", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  resources: () => request<{ resources: ProtectedResource[] }>("/api/resources"),
  adminResources: () => request<{ resources: ProtectedResource[] }>("/api/admin/resources"),
  createResource: (body: { category: string; label: string; sourceAgentId: string; description: string; sharingEligible: boolean; offerDescriptor: string }) => request<{ resource: ProtectedResource }>("/api/resources", { method: "POST", body: JSON.stringify(body) }),
  resource: (id: string) => request<{ resource: ProtectedResourceDetail }>("/api/resources/" + id),
  updateResource: (id: string, body: { category: string; label: string; sourceAgentId: string; description: string; sharingEligible: boolean; offerDescriptor: string }) => request<{ resource: ProtectedResource }>("/api/resources/" + id, { method: "PATCH", body: JSON.stringify(body) }),
  deleteResource: (id: string) => request<void>("/api/resources/" + id, { method: "DELETE" }),
  policy: () => request<{ policy: AuthorizationPolicy | null }>("/api/authorization/policy"),
  submitStoryPolicy: (sourceText: string) => request<{ policy: AuthorizationPolicy }>("/api/authorization/policy", { method: "PUT", body: JSON.stringify({ sourceText }) }),
  revokePolicy: (id: string) => request<{ policy: AuthorizationPolicy }>("/api/authorization/policy/" + id + "/revoke", { method: "POST" }),
  setAgentAuthorization: (id: string, status: "active" | "disabled") => request<{ agent: Agent }>("/api/agents/" + id + "/authorization/" + (status === "active" ? "enable" : "disable"), { method: "POST" }),
  authorizationDecisions: (runId: string) => request<{ decisions: AuthorizationDecision[] }>("/api/runs/" + runId + "/authorization-decisions"),
};
