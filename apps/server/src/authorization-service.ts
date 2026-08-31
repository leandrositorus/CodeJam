import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { JsonStore } from "./store.js";
import { ArkSharingEvaluator, type SharingEvaluator } from "./story-sharing-evaluator.js";
import { ChatResourceSummarizer } from "./chat-resource-summarizer.js";
import type {
  Agent, AuthenticatedActor, AuthorizationAction, AuthorizationDecision,
  UserAuthorizationPolicy, ProtectedResource, AccessOffer, CrossOwnerGrant,
} from "./types.js";

const now = () => new Date().toISOString();
type ResourceDescriptor = Omit<ProtectedResource, "description" | "sourceAgentId">;
type ResourceCreateInput = Pick<ProtectedResource, "category" | "label" | "sourceAgentId" | "description"> & { sharingEligible?: boolean | undefined; offerDescriptor?: string | undefined };
type ResourceUpdateInput = { category?: string | undefined; label?: string | undefined; sourceAgentId?: string | null | undefined; description?: string | undefined; sharingEligible?: boolean | undefined; offerDescriptor?: string | undefined };

export class AuthorizationService {
  constructor(private readonly config: AppConfig, private readonly store: JsonStore, private readonly sharingEvaluator: SharingEvaluator = new ArkSharingEvaluator(config), private readonly summarizer: Pick<ChatResourceSummarizer, "summarize"> = new ChatResourceSummarizer(config)) {}

  listResources(actor: AuthenticatedActor): ResourceDescriptor[] {
    return this.store.snapshot().protectedResources.filter((item) => item.ownerId === actor.id).map((item) => this.descriptor(item));
  }

  listResourceInventory(actor: AuthenticatedActor): ResourceDescriptor[] {
    this.requireAdmin(actor);
    return this.store.snapshot().protectedResources.map((item) => this.descriptor(item));
  }

  getResource(actor: AuthenticatedActor, id: string): ProtectedResource {
    const resource = this.store.snapshot().protectedResources.find((item) => item.id === id && item.ownerId === actor.id);
    if (!resource) throw new HttpError(404, "Protected resource not found");
    return resource;
  }

  resourceDirectory(ownerId: string): Array<Pick<ProtectedResource, "id" | "label" | "category">> {
    return this.store.snapshot().protectedResources.filter((item) => item.ownerId === ownerId).map(({ id, label, category }) => ({ id, label, category }));
  }

  async createResource(actor: AuthenticatedActor, input: ResourceCreateInput): Promise<ProtectedResource> {
    const timestamp = now();
    const sharingEligible = input.sharingEligible ?? false;
    const offerDescriptor = input.offerDescriptor?.trim() ?? "";
    this.validateSharingConfiguration(sharingEligible, offerDescriptor);
    if (!input.sourceAgentId || !this.store.snapshot().agents.some((agent) => agent.id === input.sourceAgentId && agent.ownerId === actor.id)) throw new HttpError(400, "Choose one of your Agents as the chat source");
    const resource: ProtectedResource = { id: randomUUID(), ownerId: actor.id, category: input.category.trim(), label: input.label.trim(), sourceAgentId: input.sourceAgentId, description: input.description.trim(), sharingEligible, offerDescriptor, createdAt: timestamp, updatedAt: timestamp };
    await this.store.mutate((db) => {
      db.protectedResources.push(resource);
    });
    return resource;
  }

  async updateResource(actor: AuthenticatedActor, id: string, input: ResourceUpdateInput): Promise<ProtectedResource> {
    return this.store.mutate((db) => {
      const resource = db.protectedResources.find((item) => item.id === id && item.ownerId === actor.id);
      if (!resource) throw new HttpError(404, "Protected resource not found");
      const sharingEligible = input.sharingEligible ?? resource.sharingEligible;
      const offerDescriptor = input.offerDescriptor === undefined ? resource.offerDescriptor : input.offerDescriptor.trim();
      const sourceAgentId = input.sourceAgentId === undefined ? resource.sourceAgentId : input.sourceAgentId;
      if (!sourceAgentId || !db.agents.some((agent) => agent.id === sourceAgentId && agent.ownerId === actor.id)) throw new HttpError(400, "Choose one of your Agents as the chat source");
      this.validateSharingConfiguration(sharingEligible, offerDescriptor);
      Object.assign(resource, {
        ...(input.category === undefined ? {} : { category: input.category.trim() }),
        ...(input.label === undefined ? {} : { label: input.label.trim() }),
        sourceAgentId,
        ...(input.description === undefined ? {} : { description: input.description.trim() }),
        sharingEligible,
        offerDescriptor,
        updatedAt: now(),
      });
      return structuredClone(resource);
    });
  }

  async deleteResource(actor: AuthenticatedActor, id: string): Promise<void> {
    await this.store.mutate((db) => {
      const index = db.protectedResources.findIndex((item) => item.id === id && item.ownerId === actor.id);
      if (index < 0) throw new HttpError(404, "Protected resource not found");
      db.protectedResources.splice(index, 1);
    });
  }

  async submitStoryPolicy(actor: AuthenticatedActor, sourceText: string): Promise<UserAuthorizationPolicy> {
    return this.activatePolicy(actor, sourceText);
  }

  policy(actor: AuthenticatedActor): UserAuthorizationPolicy | null {
    return this.store.snapshot().authorizationPolicies.filter((item) => item.ownerId === actor.id).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  async revokePolicy(actor: AuthenticatedActor, id: string): Promise<UserAuthorizationPolicy> {
    return this.store.mutate((db) => {
      const policy = db.authorizationPolicies.find((item) => item.id === id && item.ownerId === actor.id);
      if (!policy) throw new HttpError(404, "Authorization policy not found");
      if (policy.status !== "active") throw new HttpError(409, "Authorization policy is not active");
      Object.assign(policy, { status: "revoked", revokedAt: now(), updatedAt: now() });
      this.recordEvent(db, actor.id, "policy_revoked", { policyId: policy.id });
      return structuredClone(policy);
    });
  }

  private async activatePolicy(actor: AuthenticatedActor, sourceText: string): Promise<UserAuthorizationPolicy> {
    this.validatePolicyInput(sourceText);
    return this.store.mutate((db) => {
      const timestamp = now();
      for (const policy of db.authorizationPolicies) {
        if (policy.ownerId === actor.id && policy.status === "active") {
          Object.assign(policy, { status: "superseded", updatedAt: timestamp });
          this.recordEvent(db, actor.id, "policy_superseded", { policyId: policy.id });
        }
      }
      const policy: UserAuthorizationPolicy = { id: randomUUID(), ownerId: actor.id, sourceText: sourceText.trim(), status: "active", revokedAt: null, createdAt: timestamp, updatedAt: timestamp };
      db.authorizationPolicies.push(policy);
      this.recordEvent(db, actor.id, "policy_activated", { policyId: policy.id });
      return structuredClone(policy);
    });
  }

  async setAgentStatus(actor: AuthenticatedActor, agentId: string, status: Agent["authorizationStatus"]): Promise<Agent> {
    this.requireAdmin(actor);
    return this.store.mutate((db) => {
      const agent = db.agents.find((item) => item.id === agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      agent.authorizationStatus = status;
      agent.updatedAt = now();
      this.recordEvent(db, actor.id, "agent_authorization_changed", { agentId: agent.id });
      return structuredClone(agent);
    });
  }

  async setAgentSharingEligible(actor: AuthenticatedActor, agentId: string, sharingEligible: boolean): Promise<Agent> {
    return this.store.mutate((db) => {
      const agent = db.agents.find((item) => item.id === agentId);
      if (!agent || agent.ownerId !== actor.id) throw new HttpError(404, "Agent not found");
      agent.sharingEligible = sharingEligible;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  eligibleRecipients(actor: AuthenticatedActor): Array<Pick<Agent, "id" | "name" | "ownerId">> {
    if (!this.config.crossOwnerSharingEnabled) return [];
    return this.store.snapshot().agents.filter((item) => item.sharingEligible && item.ownerId !== actor.id).map(({ id, name, ownerId }) => ({ id, name, ownerId }));
  }

  async createOffer(actor: AuthenticatedActor, input: { resourceId: string; recipientAgentId: string; expiresAt: string }): Promise<AccessOffer> {
    if (!this.config.crossOwnerSharingEnabled) throw new HttpError(404, "Cross-owner sharing is disabled");
    return this.store.mutate((db) => {
      const resource = db.protectedResources.find((item) => item.id === input.resourceId);
      const agent = db.agents.find((item) => item.id === input.recipientAgentId);
      const expiry = new Date(input.expiresAt).getTime();
      if (!resource || resource.ownerId !== actor.id || !resource.sharingEligible || !resource.sourceAgentId || !db.agents.some((item) => item.id === resource.sourceAgentId && item.ownerId === actor.id)) throw new HttpError(404, "Shareable resource not found");
      if (!agent || !agent.sharingEligible || agent.ownerId === actor.id || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 24 * 60 * 60 * 1000) throw new HttpError(400, "Recipient or expiry is not eligible");
      const existing = db.accessOffers.find((item) => item.status === "pending" && item.resourceId === resource.id && item.recipientAgentId === agent.id);
      if (existing) return structuredClone(existing);
      const offer: AccessOffer = { id: randomUUID(), resourceOwnerId: actor.id, resourceId: resource.id, recipientOwnerId: agent.ownerId, recipientAgentId: agent.id, action: "read", descriptor: resource.offerDescriptor, expiresAt: new Date(expiry).toISOString(), version: 1, status: "pending", offeredAt: now(), acceptedAt: null, rejectedAt: null, cancelledAt: null };
      db.accessOffers.push(offer);
      this.recordEvent(db, actor.id, "offer_created", { agentId: agent.id });
      return structuredClone(offer);
    });
  }

  listOffers(actor: AuthenticatedActor): AccessOffer[] {
    if (!this.config.crossOwnerSharingEnabled) return [];
    const db = this.store.snapshot();
    return db.accessOffers
      .filter((item) => actor.role === "admin" || item.resourceOwnerId === actor.id || item.recipientOwnerId === actor.id)
      .sort((a, b) => b.offeredAt.localeCompare(a.offeredAt))
      .map((item) => {
        const resource = db.protectedResources.find((candidate) => candidate.id === item.resourceId);
        const recipientAgent = db.agents.find((candidate) => candidate.id === item.recipientAgentId);
        return {
          ...item,
          resourceId: item.recipientOwnerId === actor.id && actor.role !== "admin" ? "" : item.resourceId,
          resourceCategory: resource?.category ?? null,
          recipientAgentName: recipientAgent?.name ?? null,
        };
      });
  }

  listGrants(actor: AuthenticatedActor): CrossOwnerGrant[] {
    if (!this.config.crossOwnerSharingEnabled) return [];
    return this.store.snapshot().crossOwnerGrants
      .filter((item) => actor.role === "admin" || item.resourceOwnerId === actor.id || item.recipientOwnerId === actor.id)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  }

  async respondToOffer(actor: AuthenticatedActor, id: string, expectedVersion: number, accept: boolean): Promise<AccessOffer | CrossOwnerGrant> {
    if (!this.config.crossOwnerSharingEnabled) throw new HttpError(404, "Cross-owner sharing is disabled");
    return this.store.mutate((db) => {
      const offer = db.accessOffers.find((item) => item.id === id);
      if (!offer || offer.recipientOwnerId !== actor.id) throw new HttpError(404, "Access offer not found");
      if (offer.status !== "pending" || offer.version !== expectedVersion || new Date(offer.expiresAt).getTime() <= Date.now()) throw new HttpError(409, "Access offer is stale or no longer pending");
      if (!accept) { offer.status = "rejected"; offer.rejectedAt = now(); offer.version++; this.recordEvent(db, actor.id, "offer_rejected", { agentId: offer.recipientAgentId }); return structuredClone(offer); }
      const resource = db.protectedResources.find((item) => item.id === offer.resourceId);
      const agent = db.agents.find((item) => item.id === offer.recipientAgentId);
      if (!resource || resource.ownerId !== offer.resourceOwnerId) throw new HttpError(409, "The offered resource is no longer available");
      if (!resource.sharingEligible) throw new HttpError(409, "The resource owner has disabled sharing for this resource");
      if (!resource.sourceAgentId || !db.agents.some((item) => item.id === resource.sourceAgentId && item.ownerId === resource.ownerId)) throw new HttpError(409, "The offered chat source is no longer available");
      if (!agent || agent.ownerId !== actor.id) throw new HttpError(409, "The recipient Agent is no longer available to you");
      if (!agent.sharingEligible) throw new HttpError(409, "Enable sharing offers for the recipient Agent before accepting");
      offer.status = "accepted"; offer.acceptedAt = now(); offer.version++;
      const grant: CrossOwnerGrant = { id: randomUUID(), offerId: offer.id, offerVersion: offer.version, resourceOwnerId: offer.resourceOwnerId, recipientOwnerId: actor.id, recipientAgentId: agent.id, resourceId: resource.id, action: "read", issuedAt: now(), expiresAt: offer.expiresAt, status: "active", revokedAt: null };
      db.crossOwnerGrants.push(grant);
      this.recordEvent(db, actor.id, "offer_accepted", { agentId: agent.id });
      return structuredClone(grant);
    });
  }

  async cancelOffer(actor: AuthenticatedActor, id: string): Promise<AccessOffer> {
    return this.store.mutate((db) => {
      const offer = db.accessOffers.find((item) => item.id === id);
      if (!offer || (actor.role !== "admin" && offer.resourceOwnerId !== actor.id)) throw new HttpError(404, "Access offer not found");
      if (offer.status !== "pending") throw new HttpError(409, "Only pending offers can be cancelled");
      offer.status = "cancelled"; offer.cancelledAt = now(); offer.version++; this.recordEvent(db, actor.id, "offer_cancelled", { agentId: offer.recipientAgentId });
      return structuredClone(offer);
    });
  }

  async revokeGrant(actor: AuthenticatedActor, id: string): Promise<CrossOwnerGrant> {
    return this.store.mutate((db) => {
      const grant = db.crossOwnerGrants.find((item) => item.id === id);
      if (!grant || (actor.role !== "admin" && actor.id !== grant.resourceOwnerId && actor.id !== grant.recipientOwnerId)) throw new HttpError(404, "Cross-owner grant not found");
      grant.status = "revoked"; grant.revokedAt = now(); this.recordEvent(db, actor.id, "grant_revoked", { agentId: grant.recipientAgentId });
      return structuredClone(grant);
    });
  }

  runtimeResourceDirectory(agentId: string): Array<Pick<ProtectedResource, "id" | "label" | "category" | "offerDescriptor">> {
    const db = this.store.snapshot(); const agent = db.agents.find((item) => item.id === agentId); if (!agent) return [];
    const valid = (item: ProtectedResource) => Boolean(item.sourceAgentId && db.agents.some((source) => source.id === item.sourceAgentId && source.ownerId === item.ownerId));
    const owned = db.protectedResources.filter((item) => item.ownerId === agent.ownerId && valid(item));
    const shared = this.config.crossOwnerSharingEnabled ? db.protectedResources.filter((item) => item.ownerId !== agent.ownerId && item.sharingEligible && valid(item)) : [];
    return [...owned, ...shared].map(({ id, label, category, offerDescriptor }) => ({ id, label, category, offerDescriptor }));
  }

  decisions(actor: AuthenticatedActor, runId: string): AuthorizationDecision[] {
    const db = this.store.snapshot();
    const run = db.runs.find((item) => item.id === runId);
    const agent = run && db.agents.find((item) => item.id === run.agentId);
    if (!run || !agent || (actor.role !== "admin" && agent.ownerId !== actor.id)) throw new HttpError(404, "Run not found");
    return db.authorizationDecisions.filter((item) => item.runId === runId);
  }

  async evaluate(runId: string, agentId: string, action: AuthorizationAction, resourceId: string): Promise<{ allowed: boolean; reasonCode: string; resource?: ProtectedResource }> {
    const initial = this.store.snapshot();
    const run = initial.runs.find((item) => item.id === runId);
    const agent = initial.agents.find((item) => item.id === agentId);
    const resource = initial.protectedResources.find((item) => item.id === resourceId);
    let allowed = false; let reasonCode = "ALLOW"; let policy: UserAuthorizationPolicy | undefined;
    if (!run || run.status !== "running" || run.agentId !== agentId || !agent || run.initiatingUserId !== agent.ownerId) reasonCode = "RUN_CAPABILITY_INVALID";
    else if (!resource) reasonCode = "RESOURCE_INVALID";
    else if (agent.authorizationStatus !== "active") reasonCode = "AGENT_DISABLED";
    else if (!resource.sourceAgentId || !initial.agents.some((item) => item.id === resource.sourceAgentId && item.ownerId === resource.ownerId)) reasonCode = "SOURCE_AGENT_UNAVAILABLE";
    else if (resource.ownerId === agent.ownerId) { if (action === "write") reasonCode = "WRITE_NOT_SUPPORTED"; else allowed = true; }
    else if (!this.config.crossOwnerSharingEnabled) reasonCode = "RESOURCE_OWNER_MISMATCH";
    else if (action !== "read") reasonCode = "WRITE_NOT_SUPPORTED";
    else if (!resource.sharingEligible) reasonCode = "SHARING_DISABLED";
    else {
      policy = initial.authorizationPolicies.filter((item) => item.ownerId === resource.ownerId).reverse().sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (!policy || policy.status !== "active") reasonCode = "NO_SHARING_POLICY";
      else {
        const decision = await this.sharingEvaluator.decide({ policyText: policy.sourceText, runPrompt: run.prompt, agentName: agent.name, requester: { userId: agent.ownerId, username: initial.users.find((item) => item.id === agent.ownerId)?.username ?? "", agentId: agent.id }, resourceOwner: { userId: resource.ownerId, username: initial.users.find((item) => item.id === resource.ownerId)?.username ?? "" }, resourceLabel: resource.label, resourceCategory: resource.category, offerDescription: resource.offerDescriptor });
        if (!decision) reasonCode = "SHARING_DECISION_UNAVAILABLE";
        else { allowed = decision.allowed; reasonCode = decision.allowed ? "ALLOW" : "SHARING_POLICY_DENIED"; }
      }
    }
    const finalResource = resource ? structuredClone(resource) : undefined;
    await this.store.mutate((db) => {
      const finalRun = db.runs.find((item) => item.id === runId); const finalAgent = db.agents.find((item) => item.id === agentId); const finalStoredResource = db.protectedResources.find((item) => item.id === resourceId);
      const finalPolicy = policy ? db.authorizationPolicies.find((item) => item.id === policy!.id) : undefined;
      if (allowed && (!finalRun || finalRun.status !== "running" || !finalAgent || finalAgent.authorizationStatus !== "active" || !finalStoredResource || (finalStoredResource.ownerId !== finalAgent.ownerId && (!finalStoredResource.sharingEligible || !finalPolicy || finalPolicy.status !== "active")))) { allowed = false; reasonCode = "AUTHORIZATION_STATE_CHANGED"; }
      db.authorizationDecisions.push({ id: randomUUID(), timestamp: now(), runId, initiatingUserId: run?.initiatingUserId ?? "", agentId, action, resourceId, resourceLabel: resource?.label ?? null, policyId: policy?.id ?? null, legacyTemplateId: null, result: allowed ? "allow" : "deny", reasonCode, executionResult: allowed ? "succeeded" : "not_attempted" });
    });
    return allowed && finalResource ? { allowed, reasonCode, resource: finalResource } : { allowed, reasonCode };
  }

  async read(runId: string, agentId: string, resourceId: string): Promise<{ allowed: boolean; reasonCode: string; resource?: { id: string; label: string; category: string; summary: string } }> {
    const authorization = await this.evaluate(runId, agentId, "read", resourceId);
    if (!authorization.allowed || !authorization.resource?.sourceAgentId) return { allowed: false, reasonCode: authorization.reasonCode };
    const db = this.store.snapshot();
    const messages = db.messages.filter((message) => message.agentId === authorization.resource!.sourceAgentId && message.role === "assistant").sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 12).map((message) => message.content).reverse();
    const policyBeforeSummary = db.authorizationPolicies.filter((item) => item.ownerId === authorization.resource!.ownerId && item.status === "active").map((item) => item.id).join(",");
    const summary = await this.summarizer.summarize({ category: authorization.resource.category, description: authorization.resource.description, messages });
    const current = this.store.snapshot();
    const currentRun = current.runs.find((item) => item.id === runId);
    const currentAgent = current.agents.find((item) => item.id === agentId);
    const currentResource = current.protectedResources.find((item) => item.id === resourceId);
    const currentPolicy = current.authorizationPolicies.filter((item) => item.ownerId === authorization.resource!.ownerId && item.status === "active").map((item) => item.id).join(",");
    if (currentRun?.status !== "running" || currentRun.agentId !== agentId || !currentAgent || currentAgent.authorizationStatus !== "active" ||
      currentRun.initiatingUserId !== currentAgent.ownerId || JSON.stringify(currentResource) !== JSON.stringify(authorization.resource) ||
      !current.agents.some((item) => item.id === currentResource?.sourceAgentId && item.ownerId === currentResource.ownerId) ||
      (currentResource?.ownerId !== currentAgent.ownerId && currentPolicy !== policyBeforeSummary)) {
      return { allowed: false, reasonCode: "AUTHORIZATION_STATE_CHANGED" };
    }
    return summary.summary ? { allowed: true, reasonCode: "ALLOW", resource: { id: authorization.resource.id, label: authorization.resource.label, category: authorization.resource.category, summary: summary.summary } } : { allowed: false, reasonCode: summary.reasonCode };
  }

  private validatePolicyInput(sourceText: string): void {
    if (!sourceText.trim() || sourceText.length > 8_000) throw new HttpError(400, "Sharing policy text must be between 1 and 8,000 characters");
  }

  private validateSharingConfiguration(sharingEligible: boolean, offerDescriptor: string): void {
    if (offerDescriptor.length > 500) throw new HttpError(400, "Offer descriptor must be 500 characters or fewer");
    if (sharingEligible && !offerDescriptor) throw new HttpError(400, "A safe offer descriptor is required before sharing is enabled");
  }

  descriptor(resource: ProtectedResource): ResourceDescriptor { const { description: _description, sourceAgentId: _sourceAgentId, ...safe } = resource; return safe; }
  private recordEvent(db: import("./types.js").Database, actorId: string, eventType: import("./types.js").AuthorizationLifecycleEvent["eventType"], refs: { policyId?: string; agentId?: string }): void {
    db.authorizationLifecycleEvents.push({ id: randomUUID(), timestamp: now(), actorId, eventType, policyId: refs.policyId ?? null, legacyTemplateId: null, agentId: refs.agentId ?? null });
  }

  private requireAdmin(actor: AuthenticatedActor): void { if (actor.role !== "admin") throw new HttpError(403, "Admin access required"); }
}
