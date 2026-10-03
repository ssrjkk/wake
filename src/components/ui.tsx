export function Ripple({ className = "border-[#ff6b35]" }: { className?: string }) {
  return (
    <span className="absolute inset-0 pointer-events-none">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`absolute inset-0 rounded-full border-2 ${className}`}
          style={{ animation: "wakeRipple 2.4s ease-out infinite", animationDelay: `${i * 0.6}s` }}
        />
      ))}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`bg-[#141414] rounded ${className}`} style={{ animation: "wakeShimmer 1.6s ease-in-out infinite" }} />;
}

export function NavTab({ active, onClick, label, live }: { active: boolean; onClick: () => void; label: string; live?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-1.5 px-4 py-2 rounded text-sm font-medium transition-all duration-200 ${
        active
          ? "bg-[#1a1a1a] text-[#ff6b35] border border-[#2a2a2a]"
          : "text-[#888] hover:text-[#ccc] hover:bg-[#141414]"
      }`}
    >
      {label}
      {live && (
        <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] animate-pulse" title="Живые данные" />
      )}
    </button>
  );
}
