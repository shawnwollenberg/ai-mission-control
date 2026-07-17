# ServicePilot pricing fixture

This is the isolated, deterministic repository used by the Hermes → Codex proof. Codex may edit only `src/pricing-plans.ts` and `tests/pricing-plans.test.mjs`.

Validation: `node --import tsx --test tests/pricing-plans.test.mjs`

The checkout preview is deliberately outside the allowed edit list and must continue to produce the existing Stripe test-mode message.
