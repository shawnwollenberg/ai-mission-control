"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { BrandSprite } from "@/app/brand-assets";

export default function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        setError("Email or password is incorrect.");
        return;
      }
      window.location.assign(next);
    } catch {
      setError("Mission Control could not complete authentication.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <BrandSprite asset="mark-compact" />
        <p className="section-label">Secure command access</p>
        <h1>Enter Mission Control.</h1>
        <p>Authenticate as the configured mission owner.</p>
        <form onSubmit={submit}>
          <label>
            Email
            <input
              autoComplete="username"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="launch-button" disabled={pending} type="submit">
            {pending ? "Authenticating…" : "Continue"}
          </button>
        </form>
        <p className="auth-switch">New to Mission Control? <Link href="/signup">Create an account</Link></p>
      </section>
    </main>
  );
}
