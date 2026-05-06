import { extractDateOnly } from "@/lib/shared/preorder-dates";

export type BandcampPreorderSignalKind =
  | "current_upcoming"
  | "stale_historical"
  | "needs_release_date"
  | "not_preorder";

export function isRecentBandcampProduct(input: {
  today: string;
  windowStart: string;
  bandcampReleaseDate: string | null | undefined;
  bandcampNewDate: string | null | undefined;
}) {
  return getRecentBandcampProductDateEvidence(input) !== null;
}

export function getRecentBandcampProductDate(input: {
  today: string;
  windowStart: string;
  bandcampReleaseDate: string | null | undefined;
  bandcampNewDate: string | null | undefined;
}) {
  return getRecentBandcampProductDateEvidence(input)?.date ?? null;
}

export function getRecentBandcampProductDateEvidence(input: {
  today: string;
  windowStart: string;
  bandcampReleaseDate: string | null | undefined;
  bandcampNewDate: string | null | undefined;
}): { date: string; source: "release" | "listed" } | null {
  const releaseDate = extractDateOnly(input.bandcampReleaseDate);
  const newDate = extractDateOnly(input.bandcampNewDate);
  const candidates = [
    releaseDate ? { date: releaseDate, source: "release" as const } : null,
    newDate ? { date: newDate, source: "listed" as const } : null,
  ].filter((date): date is { date: string; source: "release" | "listed" } => Boolean(date));
  const matching = candidates
    .filter((candidate) => candidate.date >= input.windowStart && candidate.date <= input.today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1);

  return matching ?? null;
}

export function classifyBandcampPreorderSignal(input: {
  today: string;
  bandcampReleaseDate: string | null | undefined;
  bandcampNewDate: string | null | undefined;
  bandcampIsPreorder: boolean | null | undefined;
}): BandcampPreorderSignalKind {
  const releaseDate = extractDateOnly(input.bandcampReleaseDate);
  const newDate = extractDateOnly(input.bandcampNewDate);
  const candidateDate = releaseDate ?? newDate;

  if (candidateDate && candidateDate > input.today) return "current_upcoming";
  if (input.bandcampIsPreorder === true && candidateDate) return "stale_historical";
  if (input.bandcampIsPreorder === true && !candidateDate) return "needs_release_date";
  return "not_preorder";
}

export function summarizeBandcampPreorderSignals<
  T extends { signalKind: BandcampPreorderSignalKind },
>(rows: T[]) {
  return {
    currentUpcoming: rows.filter((row) => row.signalKind === "current_upcoming").length,
    staleHistorical: rows.filter((row) => row.signalKind === "stale_historical").length,
    needsReleaseDate: rows.filter((row) => row.signalKind === "needs_release_date").length,
  };
}
