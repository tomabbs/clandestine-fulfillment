import Link from "next/link";

export default function PortalNotFound() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center space-y-3">
        <h2 className="text-xl font-semibold">Page not found</h2>
        <p className="text-muted-foreground text-sm">This page does not exist.</p>
        <Link href="/portal" className="text-sm text-primary hover:underline">
          Back to Home
        </Link>
      </div>
    </div>
  );
}
