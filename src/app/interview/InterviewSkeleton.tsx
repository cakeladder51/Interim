export default function InterviewSkeleton() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b px-4 py-3 flex items-center justify-between animate-pulse" style={{ borderColor: "var(--foreground)", borderWidth: "0 0 1px 0" }}>
        <div className="flex items-center gap-4">
          <div className="w-16 h-4 bg-current opacity-20 rounded" />
          <div className="w-32 h-3 bg-current opacity-20 rounded" />
        </div>
        <div className="w-28 h-4 bg-current opacity-20 rounded" />
      </header>
      <div className="flex-1 flex flex-col md:flex-row">
        <div className="flex-1 p-4 animate-pulse">
          <div className="w-48 h-3 bg-current opacity-20 rounded mb-4" />
          <div className="w-full h-20 bg-current opacity-20 rounded mb-4" />
          <div className="w-64 h-3 bg-current opacity-20 rounded mb-2" />
          <div className="w-56 h-16 bg-current opacity-20 rounded" />
        </div>
        <div className="md:w-1/2 border-t md:border-t-0 md:border-l p-4 animate-pulse" style={{ borderColor: "var(--foreground)" }}>
          <div className="w-32 h-3 bg-current opacity-20 rounded mb-2" />
          <div className="w-full h-4 bg-current opacity-20 rounded mb-2" />
          <div className="w-24 h-3 bg-current opacity-20 rounded" />
        </div>
      </div>
      <div className="border-t p-4 animate-pulse" style={{ borderColor: "var(--foreground)" }}>
        <div className="max-w-md mx-auto flex gap-2">
          <div className="flex-1 h-10 bg-current opacity-20 rounded" />
          <div className="w-16 h-10 bg-current opacity-20 rounded" />
        </div>
      </div>
    </div>
  );
}
