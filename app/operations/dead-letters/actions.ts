"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requirePageIdentity } from "@/lib/page-auth";
import { cancelDeadLetter, retryDeadLetter, reviewDeadLetter } from "@/application/dead-letter-operations";
export async function deadLetterAction(form: FormData) {
  const identity = await requirePageIdentity("/operations/dead-letters");
  const input = {
    actor: { workspaceId: identity.workspaceId, userId: identity.userId, role: identity.role },
    commandId: String(form.get("commandId") ?? randomUUID()),
    jobId: String(form.get("jobId")),
  };
  const action = String(form.get("action"));
  if (action === "retry") await retryDeadLetter(input);
  else if (action === "cancel") await cancelDeadLetter(input);
  else await reviewDeadLetter(input);
  revalidatePath("/operations/dead-letters");
}
