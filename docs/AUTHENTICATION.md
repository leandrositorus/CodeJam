# Authentication and user administration

Launchpad has two independent authentication layers.

- `APP_AUTH_TOKEN` is an optional operator-managed bearer-token gate. It is
  required for non-loopback production deployments and remains required for
  every API endpoint except `/api/health` and `/api/auth` when configured.
- Every Agent, Run, and user-management request also requires a signed-in user
  session. Sessions are opaque, server-stored, expire after 24 hours, and are
  sent only in an HttpOnly, `SameSite=Lax` cookie.

`APP_SESSION_COOKIE_SECURE` controls the cookie's `Secure` attribute. It
defaults to `false` for the documented HTTP ECS proof-of-concept deployment.
Set it to `true` whenever Launchpad is served over HTTPS.

On a new installation, Launchpad creates one bootstrap account:

```text
username: admin
password: admin
```

Before exposing the app, replace the bootstrap password hash in the persisted
data through an approved offline administrative process. The bootstrap password
is deliberately for hackathon setup only; the web UI intentionally cannot reset
an Admin password.

Administrators can create ordinary users and reset ordinary-user passwords
from the **Users** panel. There is no public registration, self-service
password change, or Admin-account creation endpoint. Passwords are salted and
hashed with Node's `scrypt`; API responses never include a password, password
hash, bearer token, or session token.

Agents belong to the account that created them. Ordinary users see and operate
only their own Agents, Runs, and messages. Administrators can manage all
Agents and see their owner in the list. Existing v1 JSON data is migrated on
startup and its Agents are assigned to the initial Admin account.

For remote access, enter the operator token first and then sign in with a user
account. For local development without `APP_AUTH_TOKEN`, the application opens
directly at the user sign-in page.
