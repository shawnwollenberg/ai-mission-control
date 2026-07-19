"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requirePageIdentity } from "@/lib/page-auth";
import {
  deleteSchedule,
  runScheduleNow,
  setScheduleEnabled,
  setSchedulePaused,
  updateSchedule,
} from "@/application/schedule-commands";
async function actor() {
  const identity = await requirePageIdentity("/schedules");
  return { workspaceId: identity.workspaceId, userId: identity.userId, role: identity.role };
}
export async function scheduleControl(form: FormData) {
  const commandId = String(form.get("commandId") || randomUUID());
  const scheduleId = String(form.get("scheduleId"));
  const action = String(form.get("action"));
  const owner = await actor();
  let result: { missionId?: string } | undefined;
  if (action === "run_now") result = await runScheduleNow({ actor: owner, commandId, scheduleId });
  else if (action === "pause" || action === "resume")
    await setSchedulePaused({ actor: owner, commandId, scheduleId, paused: action === "pause" });
  else if (action === "disable" || action === "enable")
    await setScheduleEnabled({ actor: owner, commandId, scheduleId, enabled: action === "enable" });
  else if (action === "delete") await deleteSchedule({ actor: owner, commandId, scheduleId });
  else if (action === "update")
    await updateSchedule({
      actor: owner,
      commandId,
      scheduleId,
      name: String(form.get("name")),
      templateVersion: Number(form.get("templateVersion")),
    });
  revalidatePath("/schedules");
  if (result?.missionId) revalidatePath(`/missions/${result.missionId}`);
}
