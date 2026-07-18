import { redirect } from "next/navigation";
import { getSessionIdentity } from "@/lib/authentication";
import { safeInternalRedirect } from "@/lib/safe-redirect";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeInternalRedirect((await searchParams).next, "/missions");
  if (await getSessionIdentity()) redirect(next);
  return <LoginForm next={next} />;
}
