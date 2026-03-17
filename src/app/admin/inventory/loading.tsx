import {
  PageHeaderSkeleton,
  StatsRowSkeleton,
  TableSkeleton,
} from "@/components/shared/page-skeleton";

export default function Loading() {
  return (
    <div className="p-6 space-y-4">
      <PageHeaderSkeleton />
      <TableSkeleton rows={10} columns={7} />
    </div>
  );
}
