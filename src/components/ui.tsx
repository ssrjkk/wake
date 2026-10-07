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
        padding: "10px 16px",
        fontSize: "13px",
        fontWeight: active ? 600 : 500,
        transition: "all 0.15s",
        minHeight: "44px",
        color: active ? "#e5e5e5" : "#737373",
        background: active ? "rgba(59, 130, 246, 0.05)" : "transparent",
        border: "none",
        borderBottom: active ? "2px solid #3b82f6" : "2px solid transparent",
        borderRadius: "6px 6px 0 0",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.color = "#a3a3a3";
          e.currentTarget.style.background = "rgba(255, 255, 255, 0.02)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.color = "#737373";
          e.currentTarget.style.background = "transparent";
        }
      }}
    >
      {label}
      {live && (
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: active ? "#3b82f6" : "#10b981",
            boxShadow: active ? "0 0 8px rgba(59, 130, 246, 0.6)" : "0 0 8px rgba(16, 185, 129, 0.6)",
            animation: "livePulse 2s ease-in-out infinite",
          }}
          title="Live data"
        />
      )}
    </button>
  );
}
