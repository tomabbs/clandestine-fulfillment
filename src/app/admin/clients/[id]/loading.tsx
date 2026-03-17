import {
  CardSkeleton,
  PageHeaderSkeleton,
  StatsRowSkeleton,
} from "@/components/shared/page-skeleton";

export default function Loading() {
  return (
    <div className="p-6 space-y-4">
      <PageHeaderSkeleton />
      <StatsRowSkeleton count={4} />
      <CardSkeleton />
    </div>
  );
}
