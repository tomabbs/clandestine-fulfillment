import Link from "next/link";

export default function AdminNotFound() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center space-y-3">
        <h2 className="text-xl font-semibold">Page not found</h2>
        <p className="text-muted-foreground text-sm">This admin page does not exist.</p>
        <Link href="/admin" className="text-sm text-primary hover:underline">
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
