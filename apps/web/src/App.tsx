import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentRun, Message, SystemInfo, User, AuthorizationPolicy, AuthorizationDecision, ProtectedResource, ProtectedResourceDetail } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [authorizationDecisions, setAuthorizationDecisions] = useState<AuthorizationDecision[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [showUsers, setShowUsers] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [collapsedOwnerIds, setCollapsedOwnerIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [showAuthorization, setShowAuthorization] = useState(false);
  const [resources, setResources] = useState<ProtectedResource[]>([]);
  const [resourceInventory, setResourceInventory] = useState<ProtectedResource[]>([]);
  const [policy, setPolicy] = useState<AuthorizationPolicy | null>(null);
  const [story, setStory] = useState("");
  const [resourceForm, setResourceForm] = useState({ category: "report", label: "", sourceAgentId: "", description: "", content: "", sharingEligible: false, offerDescriptor: "" });
  const [editingResourceId, setEditingResourceId] = useState<string | null>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const sessionCheckRef = useRef(0);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const adminAgentGroups = useMemo(() => {
    const knownOwnerIds = new Set(users.map((user) => user.id));
    const groups = [...users]
      .sort((left, right) => left.username.localeCompare(right.username))
      .map((user) => ({
        id: user.id,
        username: user.username,
        role: user.role,
        agents: agents.filter((agent) => agent.ownerId === user.id),
      }));
    const unknownAgents = agents.filter((agent) => !knownOwnerIds.has(agent.ownerId));
    if (unknownAgents.length > 0) {
      groups.push({
        id: "unknown-owner",
        username: "Unknown owner",
        role: "user",
        agents: unknownAgents,
      });
    }
    return groups;
  }, [agents, users]);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshResourceSharingData = useCallback(async (user: User) => {
    const work = [api.resources().then(({ resources: next }) => setResources(next))];
    if (user.role === "admin") work.push(api.adminResources().then(({ resources: next }) => setResourceInventory(next)));
    else setResourceInventory([]);
    await Promise.all(work);
  }, []);

  const bootstrap = useCallback(async (user: User) => {
    const work = [refreshAgents(), api.system().then(setSystem), api.policy().then(({ policy }) => setPolicy(policy)), refreshResourceSharingData(user)];
    if (user.role === "admin") {
      work.push(api.listUsers().then(({ users: next }) => setUsers(next)));
    } else {
      setUsers([]);
    }
    await Promise.all(work);
  }, [refreshAgents, refreshResourceSharingData]);

  const restoreSession = useCallback(async () => {
    const checkId = ++sessionCheckRef.current;
    try {
      const { user } = await api.session();
      if (!mountedRef.current || checkId !== sessionCheckRef.current) return;
      setCurrentUser(user);
      try {
        await bootstrap(user);
      } catch (reason) {
        if (mountedRef.current && checkId === sessionCheckRef.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    } catch (reason) {
      if (!mountedRef.current || checkId !== sessionCheckRef.current) return;
      if (!(reason instanceof ApiError && reason.status === 401)) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      setCurrentUser(null);
    }
  }, [bootstrap]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await restoreSession();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [restoreSession]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (!activeRun || ["queued", "running"].includes(activeRun.status)) { setAuthorizationDecisions([]); return; }
    void api.authorizationDecisions(activeRun.id).then(({ decisions }) => setAuthorizationDecisions(decisions)).catch(() => setAuthorizationDecisions([]));
  }, [activeRun]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await api.system();
      setAuthRequired(false);
      setAuthInput("");
      await restoreSession();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const checkId = ++sessionCheckRef.current;
    try {
      const { user } = await api.login(username, password);
      if (checkId !== sessionCheckRef.current) return;
      setCurrentUser(user);
      setPassword("");
      try {
        await bootstrap(user);
      } catch (reason) {
        if (checkId === sessionCheckRef.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    } catch (reason) {
      if (checkId !== sessionCheckRef.current) return;
      setError(
        reason instanceof ApiError && reason.status === 401
          ? "The username or password is not valid."
          : reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      if (checkId === sessionCheckRef.current) setBusy(false);
    }
  };

  const logout = async () => {
    ++sessionCheckRef.current;
    setBusy(true);
    try {
      await api.logout();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCurrentUser(null);
      setAgents([]);
      setUsers([]);
      setSelectedId(null);
      setMessages([]);
      setSystem(null);
      setBusy(false);
    }
  };

  const createUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createUser(newUsername, newPassword);
      const { users: next } = await api.listUsers();
      setUsers(next);
      setNewUsername("");
      setNewPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const resetUserPassword = async (user: User) => {
    const nextPassword = window.prompt("New password for " + user.username + ":");
    if (!nextPassword) return;
    setBusy(true);
    setError(null);
    try {
      await api.resetUserPassword(user.id, nextPassword);
      setError("Password reset for " + user.username + ".");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const submitStory = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { const result = await api.submitStoryPolicy(story); setPolicy(result.policy); setStory(""); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  const revokePolicy = async () => { if (!policy) return; setBusy(true); setError(null); try { await api.revokePolicy(policy.id); setPolicy(null); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  const resetResourceEditor = () => { setEditingResourceId(null); setResourceForm({ category: "report", label: "", sourceAgentId: "", description: "", content: "", sharingEligible: false, offerDescriptor: "" }); };
  const saveResource = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentUser) return;
    setBusy(true);
    setError(null);
    try {
      const ownedAgents = agents.filter((agent) => agent.ownerId === currentUser.id);
      const sourceAgentId = resourceForm.sourceAgentId || (selected?.ownerId === currentUser.id ? selected.id : ownedAgents[0]?.id) || "";
      if (!sourceAgentId) {
        setError("Create an Agent before creating a protected resource.");
        return;
      }
      const body = { category: resourceForm.category, label: resourceForm.label, sourceAgentId, description: resourceForm.description || resourceForm.content, sharingEligible: resourceForm.sharingEligible, offerDescriptor: resourceForm.offerDescriptor };
      if (editingResourceId) await api.updateResource(editingResourceId, body); else await api.createResource(body);
      await refreshResourceSharingData(currentUser);
      resetResourceEditor();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const editResource = async (id: string) => { setBusy(true); setError(null); try { const { resource } = await api.resource(id); const detail: ProtectedResourceDetail = resource; setResourceForm({ category: detail.category, label: detail.label, sourceAgentId: detail.sourceAgentId ?? "", description: detail.description, content: detail.description, sharingEligible: detail.sharingEligible, offerDescriptor: detail.offerDescriptor }); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  const deleteResource = async (id: string) => { if (!currentUser || !window.confirm("Delete this protected resource? Existing offers and grants will no longer be usable.")) return; setBusy(true); setError(null); try { await api.deleteResource(id); await refreshResourceSharingData(currentUser); if (editingResourceId === id) resetResourceEditor(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={login}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Sign in</h1>
          <p>Use the account provided by your Launchpad administrator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Username
            <input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </label>
          <button className="button button-primary" disabled={busy || !username.trim() || !password}>
            {busy ? <Spinner /> : "Sign in"}
          </button>
        </form>
      </main>
    );
  }

  const selectAgent = (agent: Agent) => (
    <button
      className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
      key={agent.id}
      onClick={() => setSelectedId(agent.id)}
    >
      <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
      <div className="agent-card-copy">
        <strong>{agent.name}</strong>
        <span>{agent.description || "Coding Agent"}</span>
      </div>
      <span className={"mini-dot mini-" + agent.status} />
    </button>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <div className="account-controls">
          <span>Signed in as <strong>{currentUser.username}</strong></span>
          <div>
            {currentUser.role === "admin" && <button onClick={() => setShowUsers(true)}>Users</button>}
            <button onClick={() => { setShowAuthorization(true); void refreshResourceSharingData(currentUser).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }}>Authorization</button>
            <button onClick={logout} disabled={busy}>Sign out</button>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>{currentUser.role === "admin" ? "All Agents" : "Your Agents"}</span>
          <span>{agents.length}</span>
        </div>
        {currentUser.role === "admin" ? (
          <nav className="agent-tree" aria-label="Agents by owner">
            {adminAgentGroups.map((group) => {
              const collapsed = collapsedOwnerIds.has(group.id);
              return (
                <section
                  className={"agent-owner-group " + (collapsed ? "collapsed" : "")}
                  key={group.id}
                >
                  <button
                    type="button"
                    className="agent-owner-toggle"
                    aria-expanded={!collapsed}
                    onClick={() =>
                      setCollapsedOwnerIds((current) => {
                        const next = new Set(current);
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      })
                    }
                  >
                    <span className="tree-chevron" aria-hidden="true">›</span>
                    <span className="owner-avatar">
                      {group.username.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="agent-owner-copy">
                      <strong>{group.username}</strong>
                      <span>{group.role === "admin" ? "Admin" : "User"}</span>
                    </span>
                    <span className="agent-owner-count">
                      {group.agents.length}
                    </span>
                  </button>
                  {!collapsed && (
                    <div className="agent-owner-children">
                      {group.agents.length > 0 ? (
                        group.agents.map(selectAgent)
                      ) : (
                        <div className="empty-owner">No Agents</div>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </nav>
        ) : (
          <nav className="agent-list">
            {agents.map(selectAgent)}
            {agents.length === 0 && (
              <div className="empty-sidebar">
                <span>◇</span>
                Create your first coding Agent.
              </div>
            )}
          </nav>
        )}

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {showAuthorization ? (
          <section className="settings-panel authorization-panel">
            <div className="settings-title"><div><span className="eyebrow">Agent Passport</span><h2>Authorization</h2></div><button onClick={() => setShowAuthorization(false)}>×</button></div>
            <form onSubmit={submitStory}>
              <h3>My Agent policy</h3>
              <textarea value={story} onChange={(event) => setStory(event.target.value)} maxLength={8000} rows={4} placeholder="My Agents may read and write my reports for 30 minutes." required />
              <div className="panel-footer"><span>Describe when another owner’s Agent may request your shareable resources. This text is saved as written and is evaluated by Ark only when a cross-owner read is requested.</span><button className="button button-primary" disabled={busy}>Save sharing policy</button></div>
            </form>
            {policy && <article className="run-error"><strong>Current sharing policy</strong><span>{policy.sourceText}</span><button className="button button-danger" onClick={revokePolicy} disabled={busy}>Revoke policy</button></article>}
            <section className="settings-panel"><h3>My protected resources</h3><p>These are your private data items. Only resources you explicitly enable for sharing can be evaluated by Ark when another user’s Agent requests them.</p><form className="form-grid" onSubmit={saveResource}><label>Category<input value={resourceForm.category} onChange={(event) => setResourceForm({ ...resourceForm, category: event.target.value })} required /></label><label>Label<input value={resourceForm.label} onChange={(event) => setResourceForm({ ...resourceForm, label: event.target.value })} required /></label><label>Private chat description<textarea value={resourceForm.content} onChange={(event) => setResourceForm({ ...resourceForm, content: event.target.value })} rows={3} required /></label><label><input type="checkbox" checked={resourceForm.sharingEligible} onChange={(event) => setResourceForm({ ...resourceForm, sharingEligible: event.target.checked })} /> Allow request-time cross-owner sharing</label>{resourceForm.sharingEligible && <label>Safe offer description<input value={resourceForm.offerDescriptor} onChange={(event) => setResourceForm({ ...resourceForm, offerDescriptor: event.target.value })} maxLength={500} placeholder="City-level summary for local-content recommendations" required /></label>}<div><button className="button button-primary" disabled={busy}>{editingResourceId ? "Save resource" : "Create resource"}</button>{editingResourceId && <button type="button" className="button button-ghost" onClick={resetResourceEditor} disabled={busy}>Cancel</button>}</div></form><div className="template-list">{resources.length === 0 ? <p>No protected resources yet. Create one above; it remains private until you explicitly enable sharing.</p> : resources.map((resource) => <article className="agent-card" key={resource.id}><div className="agent-card-copy"><strong>{resource.label}</strong><span>{resource.category} · {resource.id}</span><span>{resource.sharingEligible ? "Sharing enabled: " + resource.offerDescriptor : "Private — not available for cross-owner offers"}</span><span>Updated {new Date(resource.updatedAt).toLocaleString()}</span></div><div><button className="button button-ghost" onClick={() => void editResource(resource.id)} disabled={busy}>Edit</button><button className="button button-danger" onClick={() => void deleteResource(resource.id)} disabled={busy}>Delete</button></div></article>)}</div></section>
            {system?.crossOwnerSharingEnabled && <section className="settings-panel"><h3>Request-time cross-owner sharing</h3><p>When you enable sharing for a resource, another Agent can request it during a Run. Ark evaluates the owner policy against that request only at read time. No offer or recipient acceptance is required.</p></section>}
            {currentUser.role === "admin" && <section className="settings-panel"><h3>Admin resource inventory</h3><p>Metadata only. Resource content and resource-management controls remain private to each owner.</p><div className="template-list">{resourceInventory.map((resource) => <article className="agent-card" key={resource.id}><div className="agent-card-copy"><strong>{resource.label}</strong><span>{resource.category} · owner {users.find((user) => user.id === resource.ownerId)?.username ?? "unknown"}</span><span>{resource.sharingEligible ? "Sharing enabled" : "Private"}</span></div></article>)}</div></section>}
          </section>
        ) : selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                  {selected.authorizationStatus === "disabled" && <span className="status status-error">authorization disabled</span>}
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                {currentUser.role === "admin" && <button className="button button-ghost" onClick={async () => { try { const next = selected.authorizationStatus === "active" ? "disabled" : "active"; await api.setAgentAuthorization(selected.id, next); await refreshAgents(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }} disabled={busy}>{selected.authorizationStatus === "active" ? "Disable access" : "Enable access"}</button>}

                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                {authorizationDecisions.length > 0 && <article className="run-error"><strong>Authorization evidence</strong>{authorizationDecisions.map((decision) => <span key={decision.id}>{decision.action} {decision.resourceLabel ?? "resource"}: {decision.reasonCode}</span>)}</article>}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}

      {showUsers && currentUser.role === "admin" && (
        <div className="modal-backdrop" onMouseDown={() => setShowUsers(false)}>
          <section className="modal users-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Administration</span>
                <h2>Users</h2>
                <p>Create ordinary users and reset their passwords.</p>
              </div>
              <button type="button" onClick={() => setShowUsers(false)}>×</button>
            </div>
            <form className="user-create-form" onSubmit={createUser}>
              <input placeholder="Username" value={newUsername} onChange={(event) => setNewUsername(event.target.value)} minLength={3} maxLength={40} required />
              <input type="password" placeholder="Temporary password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={1} maxLength={256} required />
              <button className="button button-primary" disabled={busy}>Add user</button>
            </form>
            <div className="users-list">
              {users.map((user) => (
                <div key={user.id} className="user-row">
                  <div><strong>{user.username}</strong><span>{user.role}</span></div>
                  {user.role === "user" && <button className="button button-ghost" onClick={() => void resetUserPassword(user)} disabled={busy}>Reset password</button>}
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
