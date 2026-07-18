import { requirePageIdentity } from "@/lib/page-auth";
import LaunchForm from "./launch-form";

export const dynamic = "force-dynamic";

export default async function LaunchPage() {
  await requirePageIdentity("/");
  return <LaunchForm />;
}
