import { NextResponse } from "next/server";
import { createMission, Priority } from "@/lib/mission-store";

const priorities: Priority[] = ["High", "Normal", "Low"];

export async function POST(request: Request) {
  const body = (await request.json()) as Partial<{
    objective: string;
    deadline: string;
    priority: Priority;
  }>;

  if (!body.objective?.trim()) {
    return NextResponse.json({ error: "Objective is required" }, { status: 400 });
  }

  const mission = await createMission({
    objective: body.objective,
    deadline: body.deadline ?? "Today",
    priority: priorities.includes(body.priority as Priority) ? (body.priority as Priority) : "Normal",
  });

  return NextResponse.json({ missionId: mission.id }, { status: 201 });
}
