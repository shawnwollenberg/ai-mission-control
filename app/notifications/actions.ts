"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requirePageIdentity } from "@/lib/page-auth";
import {
  NOTIFICATION_CATEGORIES,
  setNotificationPreferences,
  type NotificationSeverity,
} from "@/application/notification-preferences";
export async function updateNotificationPreferences(form: FormData) {
  const identity = await requirePageIdentity("/notifications");
  await setNotificationPreferences({
    actor: { workspaceId: identity.workspaceId, userId: identity.userId, role: identity.role },
    commandId: randomUUID(),
    inAppEnabled: form.get("inApp") === "on",
    emailEnabled: form.get("email") === "on",
    outboundEnabled: form.get("outbound") === "on",
    deliveryMode: String(form.get("deliveryMode")) as "immediate" | "digest",
    minimumSeverity: String(form.get("minimumSeverity")) as NotificationSeverity,
    categories: NOTIFICATION_CATEGORIES.filter((category) => form.get(`category:${category}`) === "on"),
    quietHoursStart: String(form.get("quietStart") || "") || null,
    quietHoursEnd: String(form.get("quietEnd") || "") || null,
    timeZone: String(form.get("timeZone") || "UTC"),
    dailyDigestTime: String(form.get("digestTime") || "09:00"),
    highSeverityOverride: form.get("highOverride") === "on",
    emailDestinationRef: String(form.get("emailRef") || "") || null,
    outboundDestinationRef: String(form.get("outboundRef") || "") || null,
  });
  revalidatePath("/notifications");
}
