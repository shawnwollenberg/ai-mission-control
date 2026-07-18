# Phase 1 Authentication Decision

**Status:** Approved implementation choice for the single-user Phase 1 deployment

Mission Control uses `bcryptjs` for password verification and `jose` for signed session tokens. Both are maintained packages with Node.js and Next.js support; no application-defined cryptographic token format is introduced.

## Session model

- The initial owner authenticates with email and password through a server route.
- The password is verified against a bcrypt hash stored in PostgreSQL. Plaintext passwords are never stored or logged.
- The server issues a short-lived HS256 JWT using `jose` and stores it only in an `HttpOnly` cookie.
- The cookie is `SameSite=Lax`, path `/`, and `Secure` in production.
- The JWT contains the user ID, default workspace ID, membership role, email, issued/expiry times, issuer, and audience.
- Server routes and server-rendered pages validate the signature, issuer, audience, expiry, user, and active workspace membership. Browser JavaScript cannot read the token.
- Mutating browser routes validate `Origin` against `PUBLIC_APP_URL` in addition to SameSite cookie protection. API bearer credentials remain separate and are never exposed to browser code.

Session keys come from `MISSION_CONTROL_SESSION_SECRET` and must contain at least 32 characters. Rotation is supported by accepting comma-separated keys with the current signing key first; validation tries each configured key.

## Local development

Generate a bcrypt hash without persisting the plaintext password:

```bash
npm run auth:hash -- 'choose-a-local-password'
```

Set `MISSION_CONTROL_OWNER_EMAIL`, `MISSION_CONTROL_OWNER_NAME`, `MISSION_CONTROL_OWNER_PASSWORD_HASH`, and `MISSION_CONTROL_SESSION_SECRET` in the process environment. Then run `npm run db:seed`. Re-running the seed does not replace an existing password hash or duplicate the workspace, user, or membership.

## Deployment requirements

The owner email, bcrypt hash, and session secret are provisioned through the deployment secret provider. Production must use HTTPS and set `PUBLIC_APP_URL` to the canonical HTTPS origin. Phase 1 intentionally has no signup, invitations, password reset, billing, OAuth selection, or advanced RBAC. A multi-user OIDC provider can replace the login adapter later without changing workspace-scoped authorization.
