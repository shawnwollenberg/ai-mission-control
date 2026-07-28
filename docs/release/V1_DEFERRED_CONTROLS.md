# V1 Deferred Controls

| Control                                        | Risk accepted                                                  | Why deferred                                                 | Trigger / priority                                   |
| ---------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| Apple signing, notarization, hardened runtime  | local binary substitution warning is checksum/permissions-only | one owner-controlled Mac                                     | before any other user's Mac; P0                      |
| Signed installer/update channel and revocation | manual operator update could select wrong bytes                | owner verifies checksum manually                             | before external distribution; P0                     |
| Secure Enclave host identity                   | exportable credential is weaker                                | existing authenticated credential plus local ownership       | before other users/machines; P1                      |
| Root helper/MDM                                | cannot manage cross-user/system services                       | v1 is same-user only                                         | only if future managed-device design requires it; P1 |
| Multi-task elected controllers                 | no HA during rollout                                           | one task simplifies fencing                                  | before desired count >1; P0                          |
| Independent attestation service                | app/deployment-attestation tooling shares verification code    | ECS API evidence is owner-verifiable                         | before multiple engineers/tenants; P1                |
| Signed OCI/Sigstore/SLSA release pipeline      | stronger supply-chain proof absent                             | clean commit/digests/provenance sufficient for owner rollout | before external customers; P0                        |
| Reproducible full image build                  | nondeterminism could complicate audit                          | digest is still immutable                                    | shortly after first use; P1                          |
| Object Lock/seven-year retention/legal hold    | privileged deletion remains possible                           | no customer/compliance duty yet                              | before regulated/customer evidence; P1               |
| Cross-account/region separation and SCPs       | larger AWS blast radius                                        | solo-owner account                                           | before team/commercial use; P1                       |
| Fleet waves/blast-radius automation            | accidental broad targeting                                     | schema permits one named agent only                          | before second agent; P0                              |
| Automatic remediation                          | manual recovery burden                                         | automation could broaden authority                           | long-term only; P3                                   |

Deferral never means completion. The production readiness checklist must link
each control to this register.
