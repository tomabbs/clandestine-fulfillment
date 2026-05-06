import { extractDateOnly } from "@/lib/shared/preorder-dates";

export type BandcampPreorderSignalKind =
  | "current_upcoming"
  | "stale_historical"
  | "needs_release_date"
  | "not_preorder";

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
