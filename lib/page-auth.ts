import { redirect } from "next/navigation";
import { getSessionIdentity } from "@/lib/authentication";

export async function requirePageIdentity(returnTo: string) {
  const identity = await getSessionIdentity();
  if (!identity) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  return identity;
}
