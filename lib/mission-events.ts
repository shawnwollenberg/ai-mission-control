export const EVENT_SCHEMA_VERSION = "1.0" as const;

export type MissionEventType =
  | "mission.created"
  | "plan.created"
  | "agent.activated"
  | "task.assigned"
  | "task.claimed"
  | "task.started"
  | "task.failed"
  | "mission.health_changed"
  | "task.delayed"
  | "recommendation.triggered"
  | "recommendation.approved"
  | "organization.reconfigured"
  | "task.completed"
  | "check.completed"
  | "preview.ready"
  | "artifact.created"
  | "mission.completed";

export type EventProducer = {
  kind: "platform" | "human" | "agent";
  id: string;
  label: string;
};

export type MissionEventData = {
  message: string;
  detail?: string;
  objective?: string;
  deadline?: string;
  priority?: "High" | "Normal" | "Low";
  commander?: string;
  artifact?: {
    kind: "file" | "git_diff" | "report";
    path: string;
    summary: string;
    validation?: string;
    provenance: "live" | "validated_fallback" | "controlled";
  };
  assignment?: {
    objective: string;
    allowedPaths: string[];
    validationCommand: string;
  };
};

export type AgentEventInput = Omit<MissionEvent, "sequence">;

export type MissionEvent = {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  eventId: string;
  missionId: string;
  sequence: number;
  type: MissionEventType;
  occurredAt: string;
  producer: EventProducer;
  correlationId: string;
  causationId?: string;
  subject?: { kind: "mission" | "task" | "artifact"; id: string };
  data: MissionEventData;
};

export type MissionProjection = {
  id: string;
  objective: string;
  deadline: string;
  priority: "High" | "Normal" | "Low";
  commander: string;
  createdAt: string;
  status: "Planning" | "Running" | "Delayed" | "Complete";
  schedule: "Planning" | "On Track" | "Delayed" | "Complete";
  risk: "Unknown" | "Low" | "Moderate" | "None";
  nextDecision: "None" | "Optimization Available";
  currentFocus: string;
  waiting: string;
  healthHeadline: string;
  healthDetail: string;
  plan: Array<{ name: string; state: "forming" | "active" | "waiting" | "complete"; owner: string }>;
  recommendation: boolean;
  approved: boolean;
  checks: string[];
  previewReady: boolean;
  artifacts: NonNullable<MissionEventData["artifact"]>[];
  completed: boolean;
};

export type ControlledEventTemplate = {
  type: MissionEventType;
  producer: EventProducer;
  subject?: MissionEvent["subject"];
  data: MissionEventData;
};

const platform = (id: string, label = "Mission Control"): EventProducer => ({ kind: "platform", id, label });
const agent = (id: string, label: string): EventProducer => ({ kind: "agent", id, label });

export const CONTROLLED_EVENT_TEMPLATES: ControlledEventTemplate[] = [
  { type: "plan.created", producer: agent("hermes", "Hermes"), data: { message: "Mission Plan created", detail: "Four workstreams are ready" } },
  { type: "agent.activated", producer: agent("research", "Research"), data: { message: "Research active", detail: "Crew assigned · Stripe Billing integration path" } },
  { type: "task.assigned", producer: platform("runtime"), subject: { kind: "task", id: "task-implementation" }, data: { message: "Implementation waiting on Research", detail: "Dependency recorded" } },
  { type: "agent.activated", producer: agent("testing", "Testing"), data: { message: "Testing standing by", detail: "Validation plan prepared" } },
  { type: "agent.activated", producer: agent("deployment", "Deployment"), data: { message: "Deployment reserved", detail: "Demo environment held" } },
  { type: "mission.health_changed", producer: platform("health"), data: { message: "Mission is on track", detail: "Critical path within today’s deadline" } },
  { type: "task.delayed", producer: agent("research", "Research"), subject: { kind: "task", id: "task-research" }, data: { message: "Research estimate exceeded", detail: "Billing architecture unresolved · +7 min" } },
  { type: "mission.health_changed", producer: platform("health"), data: { message: "Critical path blocked", detail: "Research exceeded estimate · coding waiting" } },
  { type: "recommendation.triggered", producer: platform("optimizer"), data: { message: "Reorganization available", detail: "Three resources can begin work immediately" } },
  { type: "recommendation.approved", producer: { kind: "human", id: "commander", label: "You" }, data: { message: "Reorganization approved", detail: "One human intervention recorded" } },
  { type: "organization.reconfigured", producer: platform("runtime"), data: { message: "Organization reconfigured", detail: "Implementation split · validation started early" } },
  { type: "task.completed", producer: agent("research", "Research"), subject: { kind: "task", id: "task-research" }, data: { message: "Billing architecture resolved" } },
  { type: "task.completed", producer: agent("coding", "Coding"), subject: { kind: "task", id: "task-implementation" }, data: { message: "Stripe Billing integrated" } },
  { type: "check.completed", producer: agent("testing", "Testing"), data: { message: "Projection tests passed" } },
  { type: "check.completed", producer: platform("build", "Build"), data: { message: "Production build passed" } },
  { type: "check.completed", producer: agent("testing", "Testing"), data: { message: "Preview interaction passed" } },
  { type: "preview.ready", producer: agent("deployment", "Deployment"), data: { message: "Preview ready", detail: "Controlled local environment · no live charges" } },
  { type: "mission.completed", producer: platform("runtime"), data: { message: "Mission complete", detail: "Completed in 14m 52s · 7m saved" } },
];

export function projectMission(events: MissionEvent[]): MissionProjection {
  const created = events.find((event) => event.type === "mission.created");
  if (!created) throw new Error("Mission projection requires mission.created");

  const state: MissionProjection = {
    id: created.missionId,
    objective: created.data.objective ?? "Untitled mission",
    deadline: created.data.deadline ?? "Today",
    priority: created.data.priority ?? "Normal",
    commander: created.data.commander ?? "Hermes",
    createdAt: created.occurredAt,
    status: "Planning",
    schedule: "Planning",
    risk: "Unknown",
    nextDecision: "None",
    currentFocus: "Planning…",
    waiting: "None",
    healthHeadline: "Organization forming",
    healthDetail: "Hermes is building the Mission Plan.",
    plan: [
      { name: "Research", state: "forming", owner: "Research" },
      { name: "Implementation", state: "forming", owner: "Coding" },
      { name: "Validation", state: "forming", owner: "Testing" },
      { name: "Delivery", state: "forming", owner: "Deployment" },
    ],
    recommendation: false,
    approved: false,
    checks: [],
    previewReady: false,
    artifacts: [],
    completed: false,
  };

  for (const event of events) {
    if (event.type === "plan.created") { state.status = "Running"; state.currentFocus = "Mission Plan created"; }
    if (event.type === "agent.activated" && event.producer.id === "research") { state.plan[0].state = "active"; state.currentFocus = "Research active"; }
    if (event.type === "task.assigned" && event.subject?.id === "task-implementation") { state.plan[1].state = "waiting"; state.waiting = "Implementation"; }
    if (event.type === "agent.activated" && event.producer.id === "testing") state.plan[2].state = "waiting";
    if (event.type === "agent.activated" && event.producer.id === "deployment") state.plan[3].state = "waiting";
    if (event.type === "mission.health_changed" && event.data.message === "Mission is on track") {
      state.schedule = "On Track";
      state.risk = "Low";
      state.healthHeadline = "Mission on track";
      state.healthDetail = "The critical path remains inside today’s deadline.";
      state.currentFocus = "Research active";
    }
    if (event.type === "task.delayed") {
      state.status = "Delayed";
      state.schedule = "Delayed";
      state.risk = "Moderate";
      state.healthHeadline = "Critical path blocked";
      state.healthDetail = "Research exceeded estimate. Coding is waiting.";
      state.currentFocus = "Critical path blocked";
      state.waiting = "Implementation";
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
      state.currentFocus = "Parallel work active";
      state.waiting = "None";
      state.plan[1].state = "active";
      state.plan[2].state = "active";
    }
    if (event.type === "task.completed") {
      const matching = state.plan.find((item) => event.producer.label === item.owner);
      if (matching) matching.state = "complete";
    }
    if (event.type === "check.completed") state.checks.push(event.data.message);
    if (event.type === "preview.ready") state.previewReady = true;
    if (event.type === "artifact.created" && event.data.artifact) state.artifacts.push(event.data.artifact);
    if (event.type === "mission.completed") {
      state.status = "Complete";
      state.schedule = "Complete";
      state.risk = "None";
      state.healthHeadline = "Mission complete";
      state.healthDetail = "The organization is now idle.";
      state.currentFocus = "Complete";
      state.waiting = "None";
      state.completed = true;
      state.plan.forEach((item) => { item.state = "complete"; });
    }
  }

  return state;
}
