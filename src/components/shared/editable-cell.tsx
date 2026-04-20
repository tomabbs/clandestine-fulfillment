"use client";

/**
 * Inline-editable table cells for warehouse data tables.
 *
 * Ported from release-manager ProductsList.jsx EditableCell pattern.
 * Click or Enter to edit, Enter/Tab/blur saves, Escape cancels.
 * Visual feedback: pencil on hover, spinner during save, green/red flash.
 */

import { Check, Loader2, Pencil } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type FlashState = "success" | "error" | null;

const FLASH_DURATION = 1200;

function flashBg(flash: FlashState): string {
  if (flash === "success") return "bg-green-50 dark:bg-green-900/20";
  if (flash === "error") return "bg-red-50 dark:bg-red-900/20";
  return "";
}

// Shared handler: Enter on the <td> starts editing (a11y keyboard support)
function cellKeyHandler(startFn: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      startFn();
    }
  };
}

// --- EditableTextCell ---

interface EditableTextCellProps {
  value: string | null;
  onSave: (newValue: string) => Promise<void>;
  placeholder?: string;
  className?: string;
  as?: "td" | "div";
}

export function EditableTextCell({
  value,
  onSave,
  placeholder = "—",
  className = "",
  as = "td",
}: EditableTextCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<FlashState>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const CellTag = as;

  const beginEdit = useCallback(() => {
    setDraft(value ?? "");
    setEditing(true);
    setFlash(null);
  }, [value]);

  const startEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      beginEdit();
    },
    [beginEdit],
  );

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft("");
  }, []);

  const save = useCallback(async () => {
    const trimmed = draft.trim();
    if (trimmed === (value ?? "")) {
      cancel();
      return;
    }
    setEditing(false);
    setSaving(true);
    try {
      await onSave(trimmed);
      setFlash("success");
    } catch {
      setFlash("error");
    } finally {
      setSaving(false);
      setTimeout(() => setFlash(null), FLASH_DURATION);
    }
  }, [draft, value, onSave, cancel]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") cancel();
      if (e.key === "Tab") {
        e.preventDefault();
        save();
      }
    },
    [save, cancel],
  );

  if (editing) {
    return (
      <CellTag className={`px-3 py-2 ${className}`} onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={onKeyDown}
          className="w-full px-2 py-1 text-sm border border-amber-400 rounded bg-background focus:outline-none focus:ring-2 focus:ring-amber-500"
        />
      </CellTag>
    );
  }

  return (
    <CellTag
      className={`px-3 py-2 text-sm cursor-pointer group overflow-hidden transition-colors ${flashBg(flash)} ${className}`}
      onClick={startEdit}
      onKeyDown={cellKeyHandler(beginEdit)}
    >
      <span className="flex items-center gap-1 min-w-0">
        {saving ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-amber-500" />
        ) : flash === "success" ? (
          <Check className="h-3 w-3 shrink-0 text-green-500" />
        ) : null}
        <span className="truncate">{value || placeholder}</span>
        <Pencil className="h-3 w-3 shrink-0 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity" />
      </span>
    </CellTag>
  );
}

// --- EditableNumberCell ---

interface EditableNumberCellProps {
  value: number | null;
  onSave: (newValue: number | null) => Promise<void>;
  prefix?: string;
  placeholder?: string;
  className?: string;
  /** Decimal places for display. Default 2 (for prices). Use 0 for integer quantities. */
  precision?: number;
  as?: "td" | "div";
}

export function EditableNumberCell({
  value,
  onSave,
  prefix = "$",
  placeholder = "—",
  className = "",
  precision = 2,
  as = "td",
}: EditableNumberCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<FlashState>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const CellTag = as;

  const beginEdit = useCallback(() => {
    setDraft(value != null ? String(value) : "");
    setEditing(true);
    setFlash(null);
  }, [value]);

  const startEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      beginEdit();
    },
    [beginEdit],
  );

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft("");
  }, []);

  const save = useCallback(async () => {
    const parsed = draft.trim() === "" ? null : Number.parseFloat(draft);
    if (parsed !== null && Number.isNaN(parsed)) {
      cancel();
      return;
    }
    if (parsed === value) {
      cancel();
      return;
    }
    setEditing(false);
    setSaving(true);
    try {
      await onSave(parsed);
      setFlash("success");
    } catch {
      setFlash("error");
    } finally {
      setSaving(false);
      setTimeout(() => setFlash(null), FLASH_DURATION);
    }
  }, [draft, value, onSave, cancel]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") cancel();
      if (e.key === "Tab") {
        e.preventDefault();
        save();
      }
    },
    [save, cancel],
  );

  if (editing) {
    return (
      <CellTag className={`px-3 py-2 ${className}`} onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="number"
          step="0.01"
          min="0"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={onKeyDown}
          className="w-20 px-2 py-1 text-sm border border-amber-400 rounded bg-background focus:outline-none focus:ring-2 focus:ring-amber-500"
        />
      </CellTag>
    );
  }

  const display = value != null ? `${prefix}${value.toFixed(precision)}` : placeholder;

  return (
    <CellTag
      className={`px-3 py-2 text-sm text-right cursor-pointer group whitespace-nowrap transition-colors ${flashBg(flash)} ${className}`}
      onClick={startEdit}
      onKeyDown={cellKeyHandler(beginEdit)}
    >
      <span className="inline-flex items-center gap-1 justify-end">
        {saving ? (
          <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
        ) : flash === "success" ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : null}
        <span className="text-muted-foreground">{display}</span>
        <Pencil className="h-3 w-3 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity" />
      </span>
    </CellTag>
  );
}

// --- EditableSelectCell ---

interface EditableSelectCellProps {
  value: string;
  options: Array<{ value: string; label: string; className?: string }>;
  onSave: (newValue: string) => Promise<void>;
  className?: string;
  as?: "td" | "div";
}

export function EditableSelectCell({
  value,
  options,
  onSave,
  className = "",
  as = "td",
}: EditableSelectCellProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<FlashState>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const CellTag = as;

  const beginEdit = useCallback(() => {
    setEditing(true);
    setFlash(null);
  }, []);

  const startEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      beginEdit();
    },
    [beginEdit],
  );

  useEffect(() => {
    if (editing && selectRef.current) selectRef.current.focus();
  }, [editing]);

  const handleChange = useCallback(
    async (newValue: string) => {
      if (newValue === value) {
        setEditing(false);
        return;
      }
      setEditing(false);
      setSaving(true);
      try {
        await onSave(newValue);
        setFlash("success");
      } catch {
        setFlash("error");
      } finally {
        setSaving(false);
        setTimeout(() => setFlash(null), FLASH_DURATION);
      }
    },
    [value, onSave],
  );

  const currentOption = options.find((o) => o.value === value);

  if (editing) {
    return (
      <CellTag className={`px-3 py-2 ${className}`} onClick={(e) => e.stopPropagation()}>
        <select
          ref={selectRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={() => setEditing(false)}
          className="px-2 py-1 text-sm border border-amber-400 rounded bg-background focus:outline-none focus:ring-2 focus:ring-amber-500"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </CellTag>
    );
  }

  return (
    <CellTag
      className={`px-3 py-2 text-sm cursor-pointer group whitespace-nowrap transition-colors ${flashBg(flash)} ${className}`}
      onClick={startEdit}
      onKeyDown={cellKeyHandler(beginEdit)}
    >
      <span className="inline-flex items-center gap-1">
        {saving ? (
          <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
        ) : flash === "success" ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : null}
        <span className={currentOption?.className}>{currentOption?.label ?? value}</span>
        <Pencil className="h-3 w-3 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity" />
      </span>
    </CellTag>
  );
}
