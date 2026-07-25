# Mission Agent 0.6.8 production release

Date: 2026-07-25  
Disposition: production deployed and checksum-bound canary accepted

## Immutable release identity

- Mission Control source SHA:
  `e70c86e4a7ed6326616c8fbdb47d4b9542539e41`
- Project Brain source SHA:
  `09cae9482712decc20f043aecb38d944beacfe20`
- Mission Agent source SHA:
  `4a97e6a32f2cbc577875c8f4ce4f774b21f03430`
- Mission Agent version: `0.6.8`
- Mission Agent artifact SHA-256:
  `e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d`
- Detached manifest version: `1`
- Web and generic-worker image:
  `661452835066.dkr.ecr.us-east-1.amazonaws.com/mission-control@sha256:943fb676166a03819f4bc596cbedcadf9ea002e57d1e8d2bce1f0d49ba7cc9aa`
- Project Brain worker image:
  `661452835066.dkr.ecr.us-east-1.amazonaws.com/mission-control@sha256:362ea4df067a55eaae0d42cc4de3c0f5d4f38bcb320013181f49fc7bf41d08d9`
- Rollback image:
  `sha256:a7f09fb3d0c244e7ddec7b43edc6a30c34fcacf3b15267fd683c48461258fa60`
- Migration level: `0027`
- Deployment timestamp: `2026-07-25T12:47:18Z`

## Production acceptance evidence

- Canary Mission Agent:
  `0bd16e0e-98aa-4ab8-896a-f95d82ee5ad8`
- Smoke mission:
  `7c4a80d3-b02e-49ae-80d1-eb11c2ca7536`
- Smoke execution:
  `a40ed552-a8cc-4772-a94f-42e6aa9da47d`
- Context SHA-256:
  `0bd53639e0418ae89f6757f15f6e8450c0aba8990b074ff2be47d1eb77e96ebd`
- Context generation, agent receipt, agent verification, and execution
  consumption reported the same checksum.
- Closure was recorded, one learning was proposed and evaluated, and no
  automatic promotion occurred.
- Projection replay: equal across `14,747` canonical events with no
  discrepancies.

Validation completed with 112 unit tests and 56 integration tests passing.
TypeScript, ESLint, changed-file formatting, production build, image startup,
worker leasing, S3 artifact verification, and migration checks passed. The
production dependency audit reported zero vulnerabilities.

Independent security and production-safety review found no unresolved critical
or high-severity findings.

## Rollback and targeted repair

The initial rollout was rolled back to the preserved application SHA
`6a630b9d7be87c5cc121477b8a639ffc531cd743` after the generic dispatcher
incorrectly consumed a simulated execution job. Migration `0027` and the
canary upgrade were preserved.

The targeted repair at
`e70c86e4a7ed6326616c8fbdb47d4b9542539e41` made simulation jobs fail closed
in production while retaining outbox dispatch. The repaired image passed
isolated acceptance and the governed production smoke before final
acceptance.

The application rollback remains the prior SHA and immutable rollback image
listed above. Migrations are additive and must not be destructively rolled
back.
