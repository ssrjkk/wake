import React from "react";
import * as Sentry from "@sentry/react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    Sentry.captureException(error, { extra: { componentStack: errorInfo.componentStack } });
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{ minHeight: "100vh", width: "100%", background: "#0a0a0a", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div style={{ maxWidth: "420px", width: "100%", background: "#111", border: "1px solid #5c1a1a", borderRadius: "6px", padding: "24px", textAlign: "center" }}>
            <div style={{ width: "48px", height: "48px", borderRadius: "50%", background: "rgba(239, 68, 68, 0.15)", border: "1px solid #7f1d1d", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="#ef4444" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h2 style={{ color: "#fafafa", fontWeight: 600, fontSize: "16px", marginBottom: "8px" }}>Что-то пошло не так</h2>
            <p style={{ color: "#a0a0a0", fontSize: "13px", marginBottom: "16px" }}>
              Произошла ошибка при загрузке компонента. Попробуй обновить страницу.
            </p>
            {this.state.error && (
              <details style={{ textAlign: "left", marginBottom: "16px" }}>
                <summary style={{ fontSize: "11px", color: "#666", cursor: "pointer" }}>
                  Детали ошибки
                </summary>
                <pre style={{ marginTop: "8px", fontSize: "11px", color: "#ef4444", background: "#0a0a0a", borderRadius: "4px", padding: "12px", overflowX: "auto", fontFamily: "'JetBrains Mono', monospace" }}>
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <button
              onClick={() => window.location.reload()}
              style={{ background: "#3b82f6", color: "#fff", fontSize: "13px", fontWeight: 600, padding: "10px 16px", border: "none", borderRadius: "6px", cursor: "pointer", transition: "background 0.15s", minHeight: "44px" }}
              onMouseEnter={(e) => e.currentTarget.style.background = "#2563eb"}
              onMouseLeave={(e) => e.currentTarget.style.background = "#3b82f6"}
            >
              Обновить страницу
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
