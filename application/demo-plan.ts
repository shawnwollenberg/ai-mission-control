import { handleAddTaskDependency, handleCreateTask } from "@/application/task-commands";
import { stableUuid } from "@/lib/stable-id";
export async function createServicePilotPlan(workspaceId: string, userId: string, missionId: string) {
  const actor = { workspaceId, id: userId, type: "human" as const };
  const specs = [
    [
      "Inspect current billing architecture",
      "Inspect the current system and record integration boundaries",
      "Architecture findings",
      false,
    ],
    [
      "Define Stripe subscription integration plan",
      "Define a safe subscription rollout plan",
      "Integration plan",
      false,
    ],
    ["Implement subscription backend", "Simulate backend implementation work", "Backend change summary", false],
    ["Implement signup and checkout UI", "Simulate checkout UI implementation work", "UI change summary", false],
    ["Validate webhook and entitlement behavior", "Validate both implementation branches", "Validation report", true],
    ["Run tests", "Run deterministic simulated tests", "Test report", false],
    ["Prepare review artifact", "Prepare the durable mission review artifact", "Review artifact", false],
  ] as const;
  const ids = specs.map((_, i) => stableUuid(`${missionId}:demo-task:${i}`));
  for (let i = 0; i < specs.length; i++) {
    const [name, instructions, expectedOutput, approval] = specs[i];
    await handleCreateTask({
      actor,
      commandId: stableUuid(`${missionId}:create-task:${i}`),
      taskId: ids[i],
      task: {
        missionId,
        name,
        instructions,
        expectedOutput,
        priority: i === 4 ? "high" : "normal",
        riskLevel: approval ? "high" : "moderate",
        maximumAttempts: 2,
        approvalPolicy: approval ? { required: true, type: "simulated_risk" } : { required: false },
        verificationRequirements: ["Recorded deterministic verification"],
      },
    });
  }
  const edges: [[number, number], ...Array<[number, number]>] = [
    [1, 0],
    [2, 1],
    [3, 1],
    [4, 2],
    [4, 3],
    [5, 4],
    [6, 5],
  ];
  for (const [task, dependency] of edges)
    await handleAddTaskDependency({
      actor,
      commandId: stableUuid(`${missionId}:dependency:${task}:${dependency}`),
      taskId: ids[task],
      dependsOnTaskId: ids[dependency],
    });
  return ids;
}
