"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requirePageIdentity } from "@/lib/page-auth";
import {
  emergencyRevokeAllRemoteAgents,
  setEmergencyControl,
  type EmergencyControlKey,
} from "@/application/emergency-controls";
export async function updateEmergencyControl(form: FormData) {
  const identity = await requirePageIdentity("/operations");
  const actor = { workspaceId: identity.workspaceId, userId: identity.userId, role: identity.role };
  const action = String(form.get("action")),
    reason = String(form.get("reason") || "");
  if (action === "revoke_remote_agents")
    await emergencyRevokeAllRemoteAgents({ actor, commandId: randomUUID(), reason });
  else
    await setEmergencyControl({
      actor,
      commandId: randomUUID(),
      control: String(form.get("control")) as EmergencyControlKey,
      enabled: form.get("enabled") === "true",
      reason,
    });
  revalidatePath("/operations");
}
