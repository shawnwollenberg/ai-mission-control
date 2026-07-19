import Link from "next/link";
import { requirePageIdentity } from "@/lib/page-auth";
import { getDatabasePool } from "@/lib/database";
import { NOTIFICATION_CATEGORIES } from "@/application/notification-preferences";
import { updateNotificationPreferences } from "./actions";
export const dynamic = "force-dynamic";
export default async function NotificationsPage() {
  const identity = await requirePageIdentity("/notifications");
  const rows = (
    await getDatabasePool().query(
      "SELECT * FROM notification_projections WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100",
      [identity.workspaceId],
    )
  ).rows;
  const preference = (
    await getDatabasePool().query("SELECT * FROM notification_preferences WHERE workspace_id=$1", [
      identity.workspaceId,
    ])
  ).rows[0];
  return (
    <main className="archive-shell">
      <nav className="brandbar">
        <Link className="nav-link" href="/schedules">
          Schedules
        </Link>
        <Link className="nav-link" href="/missions">
          Missions
        </Link>
      </nav>
      <header className="archive-header">
        <div>
          <p className="section-label">Notification center</p>
          <h1>{rows.filter((row) => !row.read_at).length} items need review.</h1>
        </div>
      </header>
      <form className="launch-form" action={updateNotificationPreferences}>
        <h2>Owner notification preferences</h2>
        <label>
          <input type="checkbox" name="inApp" defaultChecked={preference?.in_app_enabled ?? true} /> In-app
        </label>
        <label>
          <input type="checkbox" name="email" defaultChecked={preference?.email_enabled} /> Email
        </label>
        <label>
          <input type="checkbox" name="outbound" defaultChecked={preference?.outbound_enabled} /> Discord or Hermes
          outbound
        </label>
        <label>
          Delivery
          <select name="deliveryMode" defaultValue={preference?.delivery_mode ?? "immediate"}>
            <option value="immediate">Immediate</option>
            <option value="digest">Digest</option>
          </select>
        </label>
        <label>
          Minimum severity
          <select name="minimumSeverity" defaultValue={preference?.minimum_severity ?? "info"}>
            {["info", "warning", "high", "critical"].map((severity) => (
              <option key={severity}>{severity}</option>
            ))}
          </select>
        </label>
        <label>
          Timezone
          <input name="timeZone" defaultValue={preference?.timezone ?? "UTC"} />
        </label>
        <label>
          Quiet start
          <input name="quietStart" type="time" defaultValue={preference?.quiet_hours_start?.slice?.(0, 5)} />
        </label>
        <label>
          Quiet end
          <input name="quietEnd" type="time" defaultValue={preference?.quiet_hours_end?.slice?.(0, 5)} />
        </label>
        <label>
          Digest time
          <input name="digestTime" type="time" defaultValue={preference?.daily_digest_time?.slice?.(0, 5) ?? "09:00"} />
        </label>
        <label>
          <input type="checkbox" name="highOverride" defaultChecked={preference?.high_severity_override ?? true} />{" "}
          Deliver high severity during quiet hours
        </label>
        <label>
          Email destination reference
          <input
            name="emailRef"
            defaultValue={preference?.email_destination_ref ?? ""}
            placeholder="email:operations"
          />
        </label>
        <label>
          Outbound destination reference
          <input
            name="outboundRef"
            defaultValue={preference?.outbound_destination_ref ?? ""}
            placeholder="outbound:operations"
          />
        </label>
        <fieldset>
          <legend>Categories</legend>
          {NOTIFICATION_CATEGORIES.map((category) => (
            <label key={category}>
              <input
                type="checkbox"
                name={`category:${category}`}
                defaultChecked={!preference || preference.categories.includes(category)}
              />
              {category.replaceAll("_", " ")}
            </label>
          ))}
        </fieldset>
        <button type="submit">Save preferences</button>
      </form>
      <section className="mission-table">
        {rows.map((row) => (
          <Link
            className="mission-row"
            key={row.notification_id}
            href={row.mission_id ? `/missions/${row.mission_id}` : "/schedules"}
          >
            <div>
              <strong>{row.title}</strong>
              <span>{row.summary}</span>
            </div>
            <span>{row.severity}</span>
            <span>{row.category}</span>
            <span>{row.read_at ? "read" : "unread"}</span>
            <time>{new Date(row.created_at).toLocaleString()}</time>
          </Link>
        ))}
      </section>
    </main>
  );
}
