import { Skeleton } from "@/components/ui/skeleton";

export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="rounded-md border">
      <div className="bg-muted/50 p-3 flex gap-4">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={`th-${i.toString()}`} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={`tr-${i.toString()}`} className="border-t p-3 flex gap-4">
          {Array.from({ length: columns }).map((_, j) => (
            <Skeleton key={`td-${i.toString()}-${j.toString()}`} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="rounded-lg border p-4 space-y-2">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-16" />
    </div>
  );
}

export function StatsRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${count}, 1fr)` }}>
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={`stat-${i.toString()}`} />
      ))}
    </div>
  );
}

export function PageHeaderSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-64" />
    </div>
  );
}
