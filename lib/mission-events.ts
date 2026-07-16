export type MissionEventType =
  | "mission.created"
  | "plan.created"
  | "agent.activated"
  | "task.assigned"
  | "mission.health_changed"
  | "task.delayed"
  | "recommendation.triggered"
  | "recommendation.approved"
  | "organization.reconfigured"
  | "task.completed"
  | "mission.completed";

export type MissionEvent = {
  sequence: number;
  type: MissionEventType;
  actor: string;
  message: string;
  detail?: string;
};

export type MissionProjection = {
  status: "Planning" | "Running" | "Delayed" | "Complete";
  schedule: "Planning" | "On Track" | "Delayed" | "Complete";
  risk: "Unknown" | "Low" | "Moderate" | "None";
  nextDecision: "None" | "Optimization Available";
  healthHeadline: string;
  healthDetail: string;
  plan: Array<{ name: string; state: "forming" | "active" | "waiting" | "complete"; owner: string }>;
  recommendation: boolean;
  approved: boolean;
  completed: boolean;
};

export const OPENING_EVENTS: MissionEvent[] = [
  { sequence: 1, type: "mission.created", actor: "Mission Control", message: "Mission accepted", detail: "High priority · deadline today" },
  { sequence: 2, type: "plan.created", actor: "Hermes", message: "Mission Plan generated", detail: "Four outcome-oriented workstreams established" },
  { sequence: 3, type: "agent.activated", actor: "Research", message: "Research agent activated", detail: "Stripe Billing integration path" },
  { sequence: 4, type: "task.assigned", actor: "Coding", message: "Coding agent assigned", detail: "Waiting on billing architecture" },
  { sequence: 5, type: "agent.activated", actor: "Testing", message: "Testing standing by", detail: "Validation plan prepared" },
  { sequence: 6, type: "agent.activated", actor: "Deployment", message: "Deployment reserved", detail: "Demo environment held" },
  { sequence: 7, type: "mission.health_changed", actor: "Mission Control", message: "Mission is on track", detail: "Critical path within today’s deadline" },
  { sequence: 8, type: "task.delayed", actor: "Research", message: "Research estimate exceeded", detail: "Billing architecture unresolved · +7 min" },
  { sequence: 9, type: "mission.health_changed", actor: "Mission Control", message: "Critical path blocked", detail: "Research exceeded estimate · coding waiting" },
  { sequence: 10, type: "recommendation.triggered", actor: "Mission Control", message: "Reorganization available", detail: "Three resources can begin work immediately" },
];

export const APPROVAL_EVENTS: MissionEvent[] = [
  { sequence: 11, type: "recommendation.approved", actor: "You", message: "Reorganization approved", detail: "One human intervention recorded" },
  { sequence: 12, type: "organization.reconfigured", actor: "Mission Control", message: "Organization reconfigured", detail: "Implementation split · validation started early" },
  { sequence: 13, type: "task.completed", actor: "Research", message: "Billing architecture resolved" },
  { sequence: 14, type: "task.completed", actor: "Coding", message: "Stripe Billing integrated" },
  { sequence: 15, type: "task.completed", actor: "Testing", message: "Validation passed", detail: "Policy violations: 0" },
  { sequence: 16, type: "mission.completed", actor: "Mission Control", message: "Mission complete", detail: "Completed in 14m 52s · 7m saved" },
];

const BASE_PLAN: MissionProjection["plan"] = [
  { name: "Research", state: "forming", owner: "Research" },
  { name: "Implementation", state: "forming", owner: "Coding" },
  { name: "Validation", state: "forming", owner: "Testing" },
  { name: "Delivery", state: "forming", owner: "Deployment" },
];

export function projectMission(events: MissionEvent[]): MissionProjection {
  const state: MissionProjection = {
    status: "Planning",
    schedule: "Planning",
    risk: "Unknown",
    nextDecision: "None",
    healthHeadline: "Organization forming",
    healthDetail: "Hermes is building the Mission Plan.",
    plan: BASE_PLAN.map((item) => ({ ...item })),
    recommendation: false,
    approved: false,
    completed: false,
  };

  for (const event of events) {
    if (event.type === "plan.created") state.status = "Running";
    if (event.sequence === 3) state.plan[0].state = "active";
    if (event.sequence === 4) state.plan[1].state = "waiting";
    if (event.sequence === 5) state.plan[2].state = "waiting";
    if (event.sequence === 6) state.plan[3].state = "waiting";
    if (event.sequence === 7) {
      state.schedule = "On Track";
      state.risk = "Low";
      state.healthHeadline = "Mission on track";
      state.healthDetail = "The critical path remains inside today’s deadline.";
    }
    if (event.type === "task.delayed") {
      state.status = "Delayed";
      state.schedule = "Delayed";
      state.risk = "Moderate";
      state.healthHeadline = "Critical path blocked";
      state.healthDetail = "Research exceeded estimate. Coding is waiting.";
    }
    if (event.type === "recommendation.triggered") {
      state.nextDecision = "Optimization Available";
      state.recommendation = true;
    }
    if (event.type === "recommendation.approved") {
      state.approved = true;
      state.nextDecision = "None";
    }
    if (event.type === "organization.reconfigured") {
      state.status = "Running";
      state.schedule = "On Track";
      state.risk = "Low";
      state.healthHeadline = "Organization reconfigured";
      state.healthDetail = "Three resources are now advancing the critical path.";
      state.plan[1].state = "active";
      state.plan[2].state = "active";
    }
    if (event.type === "task.completed") {
      const matching = state.plan.find((item) => event.actor === item.owner);
      if (matching) matching.state = "complete";
    }
    if (event.type === "mission.completed") {
      state.status = "Complete";
      state.schedule = "Complete";
      state.risk = "None";
      state.healthHeadline = "Mission complete";
      state.healthDetail = "The organization is now idle.";
      state.completed = true;
      state.plan.forEach((item) => { item.state = "complete"; });
    }
  }

  return state;
}
