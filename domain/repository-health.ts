import { ValidationFailedError } from "@/lib/application-errors";
import type { NewDomainEvent } from "@/lib/postgres-event-store";

export const repositoryHealthDimensions = [
  "architecture",
  "tests",
  "security",
  "technical_debt",
  "documentation",
  "dependencies",
  "ci",
] as const;
export type RepositoryHealthDimension = (typeof repositoryHealthDimensions)[number];
export type RepositoryObservation = {
  dimension: RepositoryHealthDimension;
  status: "strength" | "risk" | "unknown";
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  evidence: Array<{ path: string; line?: number; description?: string }>;
};

const penalties = { low: 6, medium: 14, high: 28, critical: 45 } as const;
const weights: Record<RepositoryHealthDimension, number> = {
  architecture: 18,
  tests: 18,
  security: 18,
  technical_debt: 14,
  documentation: 10,
  dependencies: 11,
  ci: 11,
};

export function assessRepositoryHealth(observations: RepositoryObservation[]) {
  if (!observations.length || observations.length > 70)
    throw new ValidationFailedError("Repository health requires between 1 and 70 observations");
  for (const observation of observations) {
    if (!repositoryHealthDimensions.includes(observation.dimension))
      throw new ValidationFailedError("Repository health observation has an unsupported dimension");
    if (!observation.summary.trim() || observation.summary.length > 500)
      throw new ValidationFailedError("Repository health observation summary is invalid");
    if (observation.status !== "unknown" && !observation.evidence.length)
      throw new ValidationFailedError("Assessed repository health observations require file evidence");
    for (const item of observation.evidence) {
      if (!item.path || item.path.startsWith("/") || item.path.split("/").includes(".."))
        throw new ValidationFailedError("Repository health evidence must use safe repository-relative paths");
      if (item.line !== undefined && (!Number.isInteger(item.line) || item.line < 1))
        throw new ValidationFailedError("Repository health evidence line must be positive");
    }
  }
  const dimensions = Object.fromEntries(
    repositoryHealthDimensions.map((dimension) => {
      const items = observations.filter((item) => item.dimension === dimension);
      const assessed = items.filter((item) => item.status !== "unknown");
      if (!assessed.length) return [dimension, { score: null, status: "unknown", observationCount: items.length }];
      const penalty = assessed
        .filter((item) => item.status === "risk")
        .reduce((total, item) => total + penalties[item.severity], 0);
      const score = Math.max(0, 100 - penalty);
      return [
        dimension,
        { score, status: score >= 85 ? "good" : score >= 70 ? "attention" : "at_risk", observationCount: items.length },
      ];
    }),
  ) as Record<RepositoryHealthDimension, { score: number | null; status: string; observationCount: number }>;
  const known = repositoryHealthDimensions.filter((dimension) => dimensions[dimension].score !== null);
  const knownWeight = known.reduce((total, dimension) => total + weights[dimension], 0);
  const score = knownWeight
    ? Math.round(
        known.reduce((total, dimension) => total + dimensions[dimension].score! * weights[dimension], 0) / knownWeight,
      )
    : null;
  const confidence = Math.round((knownWeight / 100) * 100);
  return { score, confidence, scoringVersion: "repository-health-v1", dimensions, observations };
}

export function createRepositoryHealthAssessment(input: {
  repositoryId: string;
  sourceMissionId: string;
  sourceExecutionId: string;
  sourceArtifactId: string;
  repositoryCommit?: string;
  observations: RepositoryObservation[];
}): NewDomainEvent {
  return {
    eventType: "repository_health.assessed",
    eventSchemaVersion: 1,
    payload: { ...input, ...assessRepositoryHealth(input.observations) },
  };
}
