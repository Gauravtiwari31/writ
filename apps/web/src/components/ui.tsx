"use client";
// The Wallet's shared pieces: one look everywhere, plus the loading, empty and error states every screen must
// have (§22 rule 30).
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect } from "react";
import { ApiError } from "../lib/api";

export function dollars(minor: string | bigint | null | undefined): string {
  if (minor === null || minor === undefined) return "–";
  const value = typeof minor === "bigint" ? minor : BigInt(minor);
  const cents = (value % 100n).toString().padStart(2, "0");
  return `$${(value / 100n).toString()}.${cents}`;
}

export function toMinor(dollarsText: string): string | null {
  const match = /^\s*\$?(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(dollarsText);
  if (match === null) return null;
  return (BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "0").padEnd(2, "0"))).toString();
}

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "seal" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-[var(--text)] text-[var(--page)]",
    seal: "bg-seal text-white",
    ghost: "border border-[var(--line)] bg-transparent text-[var(--text)]",
    danger: "border border-[var(--block)] bg-transparent text-[var(--block)]",
  }[variant];
  return <button className={`min-h-11 rounded-md px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90 ${styles} ${className}`} {...props} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-6 ${className}`}>{children}</section>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium">{label}</span>
      {hint === undefined ? null : <span className="block text-xs text-[var(--muted)]">{hint}</span>}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

export const inputClass = "min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--page)] px-3 py-2 text-sm";

export function Hash({ value, length = 16 }: { value: string | null | undefined; length?: number }) {
  if (value === null || value === undefined) return <span className="font-mono text-xs text-[var(--muted)]">–</span>;
  return (
    <span className="font-mono text-xs break-all" title={value}>
      {value.length > length ? `${value.slice(0, length)}…` : value}
    </span>
  );
}

const CHIP = {
  good: "bg-[var(--approve-bg)] text-[var(--approve)]",
  warn: "bg-[var(--review-bg)] text-[var(--review)]",
  bad: "bg-[var(--block-bg)] text-[var(--block)]",
  plain: "bg-[var(--line)] text-[var(--text)]",
};

export function Chip({ tone = "plain", children }: { tone?: keyof typeof CHIP; children: ReactNode }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${CHIP[tone]}`}>{children}</span>;
}

export function stateTone(state: string): keyof typeof CHIP {
  if (["CAPTURED", "DISPUTE_WON", "ACTIVE", "APPROVED", "APPROVE", "SUCCEEDED", "PASS"].includes(state)) return "good";
  if (["AWAITING_HUMAN", "REVIEW", "PENDING", "AUTHORIZING", "AUTHORIZED", "VERIFYING", "CAPTURING", "VOIDING", "RUNNING", "DISPUTED", "DRAFT"].includes(state)) return "warn";
  if (["BLOCKED", "BLOCK", "FAILED", "VOIDED", "REVOKED", "EXPIRED", "DISPUTE_LOST", "DECLINED", "FAIL"].includes(state)) return "bad";
  return "plain";
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="py-8 text-center text-sm text-[var(--muted)]">
      {label}
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--line)] p-6 text-center">
      <p className="font-serif text-lg">{title}</p>
      {children === undefined ? null : <div className="mt-2 text-sm text-[var(--muted)]">{children}</div>}
    </div>
  );
}

export function Problem({ error, retry }: { error: Error; retry?: () => void }) {
  const router = useRouter();
  const signedOut = error instanceof ApiError && error.status === 401;
  useEffect(() => {
    if (signedOut) router.replace("/");
  }, [signedOut, router]);
  if (signedOut) return <Loading label="Taking you to sign in…" />;
  return (
    <div role="alert" className="rounded-lg border border-[var(--block)] bg-[var(--block-bg)] p-4 text-sm text-[var(--block)]">
      <p>{error.message}</p>
      {retry === undefined ? null : (
        <button className="mt-2 underline" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

const NAV = [
  ["/home", "Home"],
  ["/writs/new", "New Writ"],
  ["/agents", "Agents"],
  ["/connect", "PayPal"],
  ["/disputes", "Disputes"],
] as const;

export function Shell({ title, children, back }: { title: string; children: ReactNode; back?: string }) {
  const path = usePathname();
  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 pb-16">
      <header className="flex items-center justify-between gap-3 py-4">
        <Link href="/home" className="flex items-center gap-2 font-serif text-xl" aria-label="Writ home">
          <span aria-hidden className="grid size-7 place-items-center rounded-full bg-seal text-sm text-white">
            W
          </span>
          Writ
        </Link>
        <Chip tone="warn">sandbox</Chip>
      </header>
      <nav aria-label="Main" className="-mx-1 mb-6 flex gap-1 overflow-x-auto border-b border-[var(--line)] pb-2 text-sm">
        {NAV.map(([href, label]) => (
          <Link key={href} href={href} aria-current={path === href ? "page" : undefined} className={`whitespace-nowrap rounded px-2 py-1 ${path === href ? "font-semibold text-seal" : "text-[var(--muted)]"}`}>
            {label}
          </Link>
        ))}
      </nav>
      {back === undefined ? null : (
        <Link href={back} className="mb-2 inline-block text-sm text-[var(--muted)] underline">
          Back
        </Link>
      )}
      <h1 className="mb-4 text-3xl">{title}</h1>
      <div className="space-y-4">{children}</div>
    </div>
  );
}
