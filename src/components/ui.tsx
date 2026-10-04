export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`rounded ${className}`} style={{ background: "var(--bg-tertiary)", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />;
}

export function NavTab({ active, onClick, label, live }: { active: boolean; onClick: () => void; label: string; live?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? "text-[var(--text-primary)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
      }`}
      style={active ? { borderBottom: "2px solid var(--blue)" } : undefined}
    >
      {label}
      {live && (
        <span className={`w-1.5 h-1.5 rounded-full live-indicator`} style={{ background: active ? "var(--blue)" : "var(--green)" }} title="Live data" />
      )}
    </button>
  );
}
