import { AppNavigation } from "@/app/app-navigation";
import { requirePageIdentity } from "@/lib/page-auth";
import { listApprovalInbox } from "@/application/governance-queries";
import ApprovalInbox from "./inbox";
export const dynamic = "force-dynamic";
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const identity = await requirePageIdentity("/approvals");
  if (identity.role !== "owner")
    return (
      <main className="durable-mission-shell">
        <h1>Owner permission required</h1>
      </main>
    );
  const filters = await searchParams;
  return (
    <main className="durable-mission-shell">
      <AppNavigation subtitle="Approval inbox" />
      <header className="mission-header compact">
        <div>
          <p className="section-label">Human authority</p>
          <h1>Approval inbox</h1>
          <p>Parameter-bound decisions for external actions.</p>
        </div>
      </header>
      <form className="mission-actions approval-filter-bar">
        <select name="status" defaultValue={filters.status ?? ""}>
          <option value="">All statuses</option>
          <option>pending</option>
          <option>granted</option>
          <option>denied</option>
          <option>expired</option>
          <option>consumed</option>
        </select>
        <select name="actionType" defaultValue={filters.actionType ?? ""}>
          <option value="">All actions</option>
          <option value="repository.push_branch">Push branch</option>
          <option value="repository.create_pull_request">Create pull request</option>
        </select>
        <select name="riskLevel" defaultValue={filters.riskLevel ?? ""}>
          <option value="">All risks</option>
          <option>high</option>
          <option>moderate</option>
          <option>low</option>
        </select>
        <button type="submit">Apply filters</button>
      </form>
      <ApprovalInbox approvals={await listApprovalInbox(identity.workspaceId, filters)} />
    </main>
  );
}
