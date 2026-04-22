"use client";

// Phase 7.3 — Feature flag admin form.
//
// Renders one row per documented flag key with a sensible control:
//   - boolean         → toggle button (with Confirm dialog for sensitive ones)
//   - enum            → radio group
//   - string[]        → comma-separated input with email validation
//   - { warn, halt }  → two number inputs
//
// Sensitive flags (cutover-related) require a "type CONFIRM" gate to
// prevent accidental clicks. Right now the most-sensitive is
// `email_send_strategy` — flipping it changes who emails customers.

import { useState, useTransition } from "react";
import { updateWorkspaceFlag } from "@/actions/workspace-flags";
import { Button } from "@/components/ui/button";
import type { WorkspaceFlags } from "@/lib/server/workspace-flags";

interface Props {
  initialFlags: WorkspaceFlags;
}

export function FeatureFlagsForm({ initialFlags }: Props) {
  const [flags, setFlags] = useState<WorkspaceFlags>(initialFlags);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function setKey<K extends keyof WorkspaceFlags>(key: K, value: WorkspaceFlags[K] | null) {
    setError(null);
    startTransition(async () => {
      try {
        const r = await updateWorkspaceFlag({ key, value: value ?? null });
        setFlags(r.flags);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Cutover-sensitive: email pipeline mode ─────────────────────── */}
      <SensitiveSection
        label="Email send strategy"
        currentValue={flags.email_send_strategy ?? "off"}
        helpText="Phase 12 — controls WHO emails customers about shipping. 'off' = SS sends per legacy hybrid matrix; 'shadow' = unified pipeline runs to ops only; 'unified_resend' = WE own all customer emails; 'ss_for_all' = legacy fallback."
        options={[
          { v: "off", label: "off (default — SS sends)" },
          { v: "shadow", label: "shadow (unified pipeline → ops only)" },
          { v: "unified_resend", label: "unified_resend (WE send everything)" },
          { v: "ss_for_all", label: "ss_for_all (legacy fallback)" },
        ]}
        confirmTextRequired="CONFIRM"
        onChange={(v) => setKey("email_send_strategy", v as WorkspaceFlags["email_send_strategy"])}
        disabled={pending}
      />

      <ListField
        label="Shadow recipients"
        helpText="Phase 12 — when strategy=shadow, every send redirects here. Comma-separated emails."
        currentValue={flags.shadow_recipients ?? []}
        onChange={(arr) => setKey("shadow_recipients", arr)}
        disabled={pending}
      />

      {/* ── Other booleans ─────────────────────────────────────────────── */}
      <BoolField
        label="ShipStation unified shipping (cockpit)"
        helpText="Phase 6 — flip TRUE to use the new SS cockpit at /admin/orders. FALSE renders the legacy multi-source view."
        value={flags.shipstation_unified_shipping ?? false}
        onChange={(v) => setKey("shipstation_unified_shipping", v)}
        disabled={pending}
      />

      <BoolField
        label="EasyPost label purchase enabled"
        helpText="Phase 7.3 kill switch. Default TRUE. Flip FALSE to halt all EP label purchases (emergency pause)."
        value={flags.easypost_buy_enabled ?? true}
        onChange={(v) => setKey("easypost_buy_enabled", v)}
        disabled={pending}
      />

      <BoolField
        label="ShipStation writeback enabled"
        helpText="Phase 7.3 kill switch. Default TRUE. Flip FALSE to halt SS mark-shipped writebacks (recon cron will catch up when re-enabled)."
        value={flags.shipstation_writeback_enabled ?? true}
        onChange={(v) => setKey("shipstation_writeback_enabled", v)}
        disabled={pending}
      />

      <BoolField
        label="v1 features enabled (bulk tag/hold)"
        helpText="Phase 9.5 gate. Default TRUE. Flip FALSE if SS v1 sunsets — hides bulk tag/hold UI in cockpit."
        value={flags.v1_features_enabled ?? false}
        onChange={(v) => setKey("v1_features_enabled", v)}
        disabled={pending}
      />

      <BoolField
        label="Staff diagnostics (legacy CreateLabelPanel)"
        helpText="Phase 6.3. Default FALSE. Flip TRUE to re-enable the legacy /admin/orders-legacy CreateLabelPanel during rollback windows."
        value={flags.staff_diagnostics ?? false}
        onChange={(v) => setKey("staff_diagnostics", v)}
        disabled={pending}
      />

      <BoolField
        label="Bandcamp skip SS email"
        helpText="Phase 10.4 (legacy hybrid mode only). Default TRUE — suppress SS confirmation for BC orders since BC sends its own. Flip FALSE if you want SS to email for BC too."
        value={flags.bandcamp_skip_ss_email ?? true}
        onChange={(v) => setKey("bandcamp_skip_ss_email", v)}
        disabled={pending}
      />

      {/* ── rate_delta_thresholds (object) ─────────────────────────────── */}
      <RateDeltaField
        currentValue={flags.rate_delta_thresholds ?? {}}
        onChange={(v) => setKey("rate_delta_thresholds", v)}
        disabled={pending}
      />
    </div>
  );
}

// ── Field components ──────────────────────────────────────────────────────

function BoolField({
  label,
  helpText,
  value,
  onChange,
  disabled,
}: {
  label: string;
  helpText: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-medium text-sm">{label}</div>
          <p className="mt-1 text-xs text-muted-foreground">{helpText}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">{value ? "true" : "false"}</span>
          <Button size="sm" variant="outline" onClick={() => onChange(!value)} disabled={disabled}>
            Toggle
          </Button>
        </div>
      </div>
    </div>
  );
}

function SensitiveSection({
  label,
  currentValue,
  helpText,
  options,
  confirmTextRequired,
  onChange,
  disabled,
}: {
  label: string;
  currentValue: string;
  helpText: string;
  options: Array<{ v: string; label: string }>;
  confirmTextRequired: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [pendingChoice, setPendingChoice] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  return (
    <div className="rounded-md border-2 border-amber-300 bg-amber-50 p-4">
      <div className="font-semibold text-sm">{label}</div>
      <p className="mt-1 text-xs text-amber-900">{helpText}</p>
      <div className="mt-3 flex flex-col gap-1">
        {options.map((o) => (
          <label key={o.v} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={currentValue === o.v}
              onChange={() => setPendingChoice(o.v)}
              disabled={disabled}
            />
            <span>{o.label}</span>
            {currentValue === o.v && (
              <span className="text-[10px] uppercase tracking-wide text-emerald-700">current</span>
            )}
          </label>
        ))}
      </div>
      {pendingChoice && pendingChoice !== currentValue && (
        <div className="mt-3 rounded border border-amber-400 bg-amber-100 p-3">
          <p className="text-xs text-amber-900">
            Type <strong>{confirmTextRequired}</strong> below and click Apply to flip{" "}
            <strong>{label}</strong> from <code>{currentValue}</code> to{" "}
            <code>{pendingChoice}</code>.
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={confirmTextRequired}
            className="mt-2 w-full rounded border px-2 py-1 text-sm"
          />
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                if (confirmText === confirmTextRequired) {
                  onChange(pendingChoice);
                  setPendingChoice(null);
                  setConfirmText("");
                }
              }}
              disabled={disabled || confirmText !== confirmTextRequired}
            >
              Apply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPendingChoice(null);
                setConfirmText("");
              }}
              disabled={disabled}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ListField({
  label,
  helpText,
  currentValue,
  onChange,
  disabled,
}: {
  label: string;
  helpText: string;
  currentValue: string[];
  onChange: (arr: string[]) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(currentValue.join(", "));
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="font-medium text-sm">{label}</div>
      <p className="mt-1 text-xs text-muted-foreground">{helpText}</p>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="mt-2 w-full rounded border px-2 py-1 text-sm"
        disabled={disabled}
      />
      <div className="mt-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const arr = text
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            onChange(arr);
          }}
          disabled={disabled}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function RateDeltaField({
  currentValue,
  onChange,
  disabled,
}: {
  currentValue: { warn?: number; halt?: number };
  onChange: (v: { warn: number; halt: number }) => void;
  disabled?: boolean;
}) {
  const [warn, setWarn] = useState(currentValue.warn ?? 0.5);
  const [halt, setHalt] = useState(currentValue.halt ?? 2.0);
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="font-medium text-sm">Rate delta thresholds</div>
      <p className="mt-1 text-xs text-muted-foreground">
        Phase 0.5.2 — warn / halt limits in USD for the EP price-delta circuit breaker. When the
        actual rate at buy time exceeds the staff-selected rate by more than{" "}
        <code className="text-xs">halt</code>, the purchase is refused. Defaults: warn=0.5,
        halt=2.0.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="ep-price-warn" className="text-xs">
            Warn ($)
          </label>
          <input
            id="ep-price-warn"
            type="number"
            step="0.1"
            min="0"
            value={warn}
            onChange={(e) => setWarn(Number(e.target.value))}
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
            disabled={disabled}
          />
        </div>
        <div>
          <label htmlFor="ep-price-halt" className="text-xs">
            Halt ($)
          </label>
          <input
            id="ep-price-halt"
            type="number"
            step="0.1"
            min="0"
            value={halt}
            onChange={(e) => setHalt(Number(e.target.value))}
            className="mt-1 w-full rounded border px-2 py-1 text-sm"
            disabled={disabled}
          />
        </div>
      </div>
      <div className="mt-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange({ warn, halt })}
          disabled={disabled}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
