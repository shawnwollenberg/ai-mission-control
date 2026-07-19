import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getDatabasePool, withTransaction } from "@/lib/database";
type DeliveryRow = {
  workspace_id: string;
  delivery_id: string;
  destination_ref: string;
  channel: string;
  category: string;
  severity: string;
  attempts: number;
  safe_payload: { title: string; summary: string; link?: string };
};

export interface NotificationProvider {
  deliver(input: {
    destinationReference: string;
    title: string;
    summary: string;
    link?: string;
  }): Promise<{ providerMessageId: string }>;
}
export class ControlledNotificationProvider implements NotificationProvider {
  async deliver(input: { destinationReference: string; title: string; summary: string }) {
    if (input.destinationReference.endsWith(":fail")) throw new Error("Controlled notification delivery failure");
    return { providerMessageId: randomUUID() };
  }
}

export async function releaseDueDigests(now = new Date()) {
  const workspaces = (
    await getDatabasePool().query(
      `SELECT p.* FROM notification_preferences p WHERE EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.workspace_id=p.workspace_id AND d.status='digest_pending')`,
    )
  ).rows;
  let released = 0;
  for (const preference of workspaces) {
    const localTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: preference.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
    if (localTime < String(preference.daily_digest_time).slice(0, 5)) continue;
    const rows = (
      await getDatabasePool().query<DeliveryRow>(
        `SELECT * FROM notification_deliveries WHERE workspace_id=$1 AND status='digest_pending' ORDER BY channel,destination_ref,category,created_at,delivery_id`,
        [preference.workspace_id],
      )
    ).rows;
    const groups = new Map<string, DeliveryRow[]>();
    for (const row of rows) {
      const key = `${row.channel}:${row.destination_ref}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of Array.from(groups.values())) {
      const [first, ...rest] = group;
      const items = group.map((row) => ({
        category: row.category,
        severity: row.severity,
        title: row.safe_payload.title,
      }));
      await getDatabasePool().query(
        "UPDATE notification_deliveries SET status='pending',safe_payload=$3,available_at=now(),updated_at=now() WHERE workspace_id=$1 AND delivery_id=$2",
        [
          preference.workspace_id,
          first.delivery_id,
          JSON.stringify({
            title: `Mission Control digest: ${items.length} items`,
            summary: items
              .map((item: { severity: string; title: string }) => `[${item.severity}] ${item.title}`)
              .join("\n"),
            link: "/notifications",
            items,
          }),
        ],
      );
      if (rest.length)
        await getDatabasePool().query(
          "UPDATE notification_deliveries SET status='suppressed',updated_at=now() WHERE workspace_id=$1 AND delivery_id=ANY($2::uuid[])",
          [preference.workspace_id, rest.map((row) => row.delivery_id)],
        );
      released += 1;
    }
  }
  return released;
}

export async function claimNotificationDelivery(workerId: string) {
  return withTransaction(async (client) => {
    const result = await client.query<DeliveryRow>(
      `SELECT * FROM notification_deliveries WHERE status IN('pending','retrying') AND available_at<=now()
       ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    await client.query(
      "UPDATE notification_deliveries SET status='delivering',attempts=attempts+1,locked_at=now(),locked_by=$3,updated_at=now() WHERE workspace_id=$1 AND delivery_id=$2",
      [row.workspace_id, row.delivery_id, workerId],
    );
    return { ...row, attempts: row.attempts + 1 };
  });
}
export async function deliverNotification(row: DeliveryRow, provider: NotificationProvider) {
  try {
    const result = await provider.deliver({ destinationReference: row.destination_ref, ...row.safe_payload });
    await getDatabasePool().query(
      "UPDATE notification_deliveries SET status='delivered',delivered_at=now(),locked_at=NULL,locked_by=NULL,last_error=NULL,updated_at=now(),safe_payload=safe_payload||$3::jsonb WHERE workspace_id=$1 AND delivery_id=$2",
      [row.workspace_id, row.delivery_id, JSON.stringify({ providerMessageId: result.providerMessageId })],
    );
    return { status: "delivered" };
  } catch (error) {
    const retrying = row.attempts < 3;
    await getDatabasePool().query(
      "UPDATE notification_deliveries SET status=$3,available_at=now()+($4*interval '1 second'),locked_at=NULL,locked_by=NULL,last_error=$5,updated_at=now() WHERE workspace_id=$1 AND delivery_id=$2",
      [
        row.workspace_id,
        row.delivery_id,
        retrying ? "retrying" : "failed",
        Math.min(60, 2 ** row.attempts),
        JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      ],
    );
    return { status: retrying ? "retrying" : "failed" };
  }
}
export async function insertDelivery(
  client: PoolClient,
  input: {
    workspaceId: string;
    notificationId: string;
    sourceEventId: string;
    category: string;
    severity: string;
    channel: "email" | "outbound";
    destinationRef: string;
    status: string;
    title: string;
    summary: string;
  },
) {
  const { stableUuid } = await import("@/lib/stable-id");
  const deliveryId = stableUuid(`notification-delivery:${input.notificationId}:${input.channel}`);
  await client.query(
    `INSERT INTO notification_deliveries(workspace_id,delivery_id,notification_id,source_event_id,category,severity,channel,destination_ref,status,idempotency_key,safe_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
    [
      input.workspaceId,
      deliveryId,
      input.notificationId,
      input.sourceEventId,
      input.category,
      input.severity,
      input.channel,
      input.destinationRef,
      input.status,
      `${input.notificationId}:${input.channel}`,
      JSON.stringify({ title: input.title, summary: input.summary, link: `/notifications` }),
    ],
  );
}
