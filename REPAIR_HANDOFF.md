# Agent Passport repair handoff

## Status

Local source fixes; nothing pushed or deployed. Original ZIP preserved.
Verified on 2026-09-01: npm run check passes (11 test files, 38 tests,
server/web typechecking, production build).
Tests use controlled model responses. They do not prove live Ark compatibility,
deployed container networking, model decisions, browser interactions or demo latency.
Do not treat this as a zero-bug or recording-ready certification.

## Fixed

- Protected-read bridge: keep the socket response side open after the helper
  finishes sending. Previously it could close before asynchronous evaluation returned.
- Sharing evaluator: include server-resolved requester username, user ID, Agent ID
  and resource-owner identity. Agent display names and prompt claims are not identity proof.
- Resource editing: Edit now enters edit mode instead of creating a duplicate;
  edited private descriptions now save instead of retaining the old description.
- Resource creation: require explicit source Agent selection instead of silently
  choosing the selected or first Agent.
- Policy ordering: newest insertion wins when policy timestamps tie.
- Reads: check authorization state again after asynchronous summarization so a
  revoked policy, disabled Agent, changed resource or stopped Run blocks delivery.
- User creation: show actionable username validation inside the modal and preserve
  backend validation details. Use fyp_user and profile_user, not names with spaces.
  Invalid names returned HTTP 400 locally, not a server crash.

## Automated verification

- Existing authentication, resource routes, service, runner and workspace tests.
- Invalid usernames: no created account, service remains responsive; valid normalized
  username can subsequently be created and used to log in.
- API client displays validation details and preserves conflict messages.
- FYP -> Profile and Profile -> FYP: sharing disabled, no policy, allowed summary,
  policy denial, unavailable evaluator, forbidden write, revocation during summary.
- Real loopback TCP bridge with delayed read response; replay rejected.

## Deploy/rehearse before recording

1. Engineer reviews the changed source against the latest main branch. This repair
   is based on the uploaded ZIP, not a fetched live branch. Preserve newer work.
2. Run npm ci and npm run check. Back up application data before deployment.
3. Deploy through the existing workflow. Confirm CROSS_OWNER_SHARING_ENABLED=true,
   supported container runtime, reachable bridge, and valid Ark configuration.
   Do not paste credentials into chats or the recording.
4. Create fyp_user and profile_user in Users. These are human accounts, not Agents.
5. Under fyp_user create FYP Planner. In its chat, ask:
   "For our fictional demo, prepare an approved FYP content brief:
   Singapore local food videos, campus-life videos, and public events.
   Return those three topics as the approved brief."
   Wait for the completed assistant reply.
6. Under fyp_user > Authorization create a resource:
   category report; label FYP Content Brief; source Agent FYP Planner;
   private chat description "Summarize only the approved FYP content brief.";
   safe offer description "Approved FYP topics for Profile collaboration".
   Initially leave sharing disabled. Record the resource ID.
7. Save fyp_user's sharing policy:
   "Allow Agents owned by profile_user to read the FYP Content Brief summary
   for coordinating local-content recommendations. Do not allow writes."
8. Under profile_user create Profile Assistant. Request a protected read of the
   exact resource ID through the Passport helper. Expect a backend denial while
   sharing is disabled. A model saying it cannot find data is NOT denial evidence.
9. Edit the resource as fyp_user, enable sharing and save. Verify no duplicate was
   created. Start a NEW Profile Assistant Run so its resource catalog is refreshed.
   Prompt: "Use the Passport helper to read protected resource <RESOURCE_ID>,
   FYP Content Brief, for coordinating local-content recommendations.
   Report the returned summary or the actual failure reason; do not guess."
10. Verify actual returned data and protected-read evidence. Disable sharing again,
    save and repeat a fresh protected read. Expect denial.
    Previously returned data is not erased by revocation.
11. Reverse the owners with Profile City Summary, backed by a completed Profile
    Assistant reply containing fictional city-only data. Repeat the same checks.

## Three-minute recording outline

- 0:00–0:25: explain separate human/Agent identities and the two fictional teams.
- 0:25–0:55: show registered source resource and sharing disabled; demonstrate denial.
- 0:55–1:25: owner enables sharing and shows saved policy.
- 1:25–2:15: requesting Agent performs a real protected read; show returned summary.
- 2:15–2:45: owner disables sharing; a fresh read is blocked.
- 2:45–3:00: summarize scoped sharing and owner control.

Prepare accounts, chat data and IDs before recording. Rehearse with the deployed
model to measure latency; the time slots above are a script, not measured performance.

## Remaining review limitations

- The current natural-language sharing policy is evaluated by a model, not a
  deterministic identity allowlist. Supplied trusted identity improves context but
  is not a proof against every prompt-injection or policy-interpretation error.
- Existing authorization evidence records permission success before summarization
  finishes; use the actual protected-read result to judge data delivery. Audit
  outcome handling needs further hardening for summary failures/revocation races.
- Earlier offer/acceptance, TTL and write-permission PRD scenarios do not describe
  this current request-time, read-only UI. They are not claimed as passed.
- The original deployed crash is not reproduced; server logs are needed to identify
  whether it was validation, networking, deployment or a separate runtime failure.
