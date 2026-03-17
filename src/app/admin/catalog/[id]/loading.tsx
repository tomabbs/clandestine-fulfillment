import { CardSkeleton, PageHeaderSkeleton } from "@/components/shared/page-skeleton";

export default function Loading() {
  return (
    <div className="p-6 space-y-4">
      <PageHeaderSkeleton />
      <div className="grid grid-cols-2 gap-4">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    </div>
  );
}
