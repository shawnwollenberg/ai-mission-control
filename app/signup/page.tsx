import { redirect } from "next/navigation";
import { getSessionIdentity } from "@/lib/authentication";
import SignupForm from "./signup-form";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  if (await getSessionIdentity()) redirect("/missions");
  return <SignupForm />;
}
