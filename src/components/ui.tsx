export function Skeleton({ height = "16px", width = "100%" }: { height?: string; width?: string }) {
  return <div style={{ height, width, background: "#1a1a1a", borderRadius: "3px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />;
}

export function NavTab({ active, onClick, label, live }: { active: boolean; onClick: () => void; label: string; live?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "8px 16px",
        fontSize: "13px",
        fontWeight: 500,
        transition: "color 0.15s",
        color: active ? "#e5e5e5" : "#737373",
        background: "transparent",
        border: "none",
        borderBottom: active ? "2px solid #3b82f6" : "2px solid transparent",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = "#a3a3a3"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = "#737373"; }}
    >
      {label}
      {live && (
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: active ? "#3b82f6" : "#10b981",
            animation: "livePulse 2s ease-in-out infinite",
          }}
          title="Live data"
        />
      )}
    </button>
  );
}
