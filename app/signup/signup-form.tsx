"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { BrandSprite } from "@/app/brand-assets";

export default function SignupForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirmation")) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: form.get("displayName"),
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) return setError(result.error ?? "Mission Control could not create your account.");
      window.location.assign("/onboarding");
    } catch {
      setError("Mission Control could not create your account.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <BrandSprite asset="mark-compact" />
        <p className="section-label">Join Mission Control</p>
        <h1>Create your account.</h1>
        <p>Create a private AI organization that you own.</p>
        <form onSubmit={submit}>
          <label>
            Name
            <input autoComplete="name" name="displayName" required minLength={2} maxLength={80} />
          </label>
          <label>
            Email
            <input autoComplete="email" name="email" type="email" required />
          </label>
          <label>
            Password
            <input autoComplete="new-password" name="password" type="password" required minLength={12} />
          </label>
          <label>
            Confirm password
            <input autoComplete="new-password" name="confirmation" type="password" required minLength={12} />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="launch-button" disabled={pending} type="submit">
            {pending ? "Creating account…" : "Create account"}
          </button>
        </form>
        <p className="auth-switch">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </section>
    </main>
  );
}
