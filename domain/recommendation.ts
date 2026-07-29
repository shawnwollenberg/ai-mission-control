import { InvalidTransitionError, ValidationFailedError } from "@/lib/application-errors";
import type { DomainEvent, NewDomainEvent } from "@/lib/postgres-event-store";

export type RecommendationStatus = "open" | "accepted" | "in_progress" | "completed" | "stale" | "dismissed";
export type RecommendationState = {
  id: string;
  status: RecommendationStatus;
  version: number;
  linkedMissionId?: string;
};

const transitions: Record<RecommendationStatus, RecommendationStatus[]> = {
  open: ["accepted", "in_progress", "stale", "dismissed"],
  accepted: ["in_progress", "stale", "dismissed"],
  // A terminal linked mission may be retried while the recommendation remains
  // in progress. The new status event preserves the replacement mission link.
  in_progress: ["in_progress", "completed", "stale", "dismissed"],
  // A completed recommendation can produce a follow-up mission when its local
  // change succeeded but publication evidence must be regenerated.
  completed: ["in_progress"],
  stale: [],
  dismissed: [],
};

const recommendationValidationCommand = /^(npm|pnpm|yarn|bun|npx|node|go|cargo|pytest)( [A-Za-z0-9_./:@=,+-]+)*$/;
const packageLifecycleScripts = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish", "publish"]);

export function assertSafeRecommendationValidation(command: string) {
  const parts = command.split(/\s+/);
  if (
    !recommendationValidationCommand.test(command) ||
    parts.some((part) => part.includes("..") && part !== "./...") ||
    (["npm", "pnpm", "yarn", "bun"].includes(parts[0]) && parts[1] === "run" && packageLifecycleScripts.has(parts[2]))
  )
    throw new ValidationFailedError(
      "Recommendation validation command is not allowed. Use one direct supported executable with simple repository-local arguments; inline code and shell operators are prohibited.",
    );
}

export function createRecommendation(input: {
  repositoryId: string;
  sourceMissionId: string;
  sourceExecutionId: string;
  sourceArtifactId?: string;
  title: string;
  description: string;
  reasoning: string;
  evidence: Array<{ path: string; line?: number; description?: string }>;
  estimatedImpact: "low" | "medium" | "high" | "critical";
  estimatedRisk: "low" | "medium" | "high";
  estimatedEffort: string;
  suggestedValidation: string[];
  acceptanceCriteria: string[];
}): NewDomainEvent {
  if (!input.title.trim() || !input.description.trim() || !input.reasoning.trim())
    throw new ValidationFailedError("Recommendation title, description, and reasoning are required");
  if (!input.evidence.length) throw new ValidationFailedError("Recommendation evidence is required");
  if (!input.acceptanceCriteria.length)
    throw new ValidationFailedError("Recommendation acceptance criteria are required");
  input.suggestedValidation.forEach(assertSafeRecommendationValidation);
  return { eventType: "recommendation.created", eventSchemaVersion: 1, payload: { ...input, status: "open" } };
}

export function transitionRecommendation(
  state: RecommendationState,
  target: RecommendationStatus,
  details: { reason?: string; linkedMissionId?: string; supersededBy?: string } = {},
): NewDomainEvent {
  if (!transitions[state.status].includes(target))
    throw new InvalidTransitionError("Recommendation", state.status, target);
  return { eventType: "recommendation.status_changed", eventSchemaVersion: 1, payload: { status: target, ...details } };
}

export function rehydrateRecommendation(events: DomainEvent[]): RecommendationState | undefined {
  if (!events.length) return undefined;
  let status = "open" as RecommendationStatus;
  let linkedMissionId: string | undefined;
  for (const event of events) {
    if (event.payload.status) status = event.payload.status as RecommendationStatus;
    if (event.payload.linkedMissionId) linkedMissionId = String(event.payload.linkedMissionId);
  }
  return {
    id: events[0].aggregateId,
    status,
    version: events.at(-1)!.aggregateVersion,
    ...(linkedMissionId ? { linkedMissionId } : {}),
  };
}
