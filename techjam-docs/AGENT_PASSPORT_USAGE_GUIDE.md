# Agent Passport Usage Guide

Agent Passport keeps people, Agents, and protected data separate:

1. An optional `APP_AUTH_TOKEN` protects a remote deployment.
2. Username/password login identifies the person using the application.
3. Each Agent owner writes a free-text sharing policy.
4. Ark evaluates that policy only when another owner’s Agent requests a shareable resource.

## Quick local setup

Start the app and sign in with the bootstrap account:

- Admin: `admin` / `admin`

Use **Users** to create ordinary accounts such as `alice` and `bob`. Change the bootstrap password before a remote demonstration.

## Set your Agent policy

1. Sign in as the Agent owner and choose **Authorization** in the sidebar.
2. Under **My Agent policy**, describe the authority needed by your own Agents. For example:

   > My Agents may read and write my reports for 30 minutes.

3. Select **Save sharing policy**. The text is stored exactly as entered; no LLM is called and no access is adjudicated at setup time.

The policy is used only for cross-owner sharing decisions. Same-owner reads remain deterministic. Use **Revoke policy** to deny later cross-owner requests immediately.

## Create a protected chat resource

1. Still in **Authorization**, open **My protected resources**.
2. Select the Agent whose completed chat responses should be scanned in the sidebar before creating the resource. If no owned Agent is selected, the first owned Agent is used.
3. Give the resource a category and label. The description is a private instruction that helps Ark identify the relevant topic in that selected Agent's chat; it is not data shared with another user.

For example, use category `local-content`, label `Local recommendations`, and description `City-level local-content recommendations from the Agent's latest response.`

When an authorized Agent reads this resource, the service analyzes the selected source Agent's recent assistant messages and returns a bounded summary. It does not return raw chat history.

## Use a protected resource in an Agent Run

Copy the resource ID and ask an Agent that has an active policy:

```text
Use Agent Passport to read protected resource <resource-id> and summarize the result.
```

The workspace exposes the read command during an active Run:

```sh
node .agent-passport.mjs read <resource-id>
```

Chat-backed protected resources are read-only. A request to write one is denied even if the owner policy includes `write`.

## Share one resource with another user's Agent (P1b)

Set `CROSS_OWNER_SHARING_ENABLED=true` and use the container runtime for cross-owner sharing.

1. The resource owner enables **Allow request-time cross-owner sharing** and enters a safe offer description. Do not put private information in that description.
2. The requesting Agent can discover only the resource ID, category, label, and safe description.
3. When that Agent runs `node .agent-passport.mjs read <resource-id>`, Ark compares the request prompt with the owner’s sharing policy and safe description.
4. If Ark allows the request, the existing chat summarizer returns a bounded read-only summary. If Ark denies or is unavailable, no source chat is sent to the summarizer.

## What the service enforces

For same-owner access, Agent Passport verifies the active Run capability, Agent status, matching resource ownership, and valid source Agent. For P1b access, it additionally requires sharing to be enabled, an active owner sharing policy, and an allow decision from Ark for that specific request.

Common safe denial codes include:

| Code | Meaning |
| --- | --- |
| `RUN_CAPABILITY_INVALID` | The request was not made from the active Agent Run. |
| `NO_SHARING_POLICY` | The resource owner has no active sharing policy. |
| `SHARING_DECISION_UNAVAILABLE` | Ark could not safely evaluate the request. |
| `POLICY_REVOKED` | The owner revoked the policy. |
| `SHARING_POLICY_DENIED` | The request does not match the owner’s policy. |
| `RESOURCE_OWNER_MISMATCH` | The Agent tried to access another user’s private resource. |

Run evidence is visible to the Run owner and Admin through the completed Run view or `GET /api/runs/<run-id>/authorization-decisions`. It never includes passwords, session cookies, bearer tokens, Run capabilities, raw protected chat content, or private resource descriptions.

## Remote deployments

When `APP_AUTH_TOKEN` is configured, enter it before username/password login. The token stays only in browser memory. The signed-in user uses an HttpOnly session cookie.
