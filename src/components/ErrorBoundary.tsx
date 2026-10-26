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
        <div style={{ minHeight: "100dvh", width: "100%", background: "var(--on-accent)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div style={{ maxWidth: "420px", width: "100%", background: "var(--bg-1)", border: "1px solid var(--down-line)", borderRadius: "6px", padding: "24px", textAlign: "center" }}>
            <div style={{ width: "48px", height: "48px", borderRadius: "50%", background: "var(--down-faint)", border: "1px solid var(--down-line)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="var(--down)" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h2 style={{ color: "var(--fg)", fontWeight: 600, fontSize: "16px", marginBottom: "8px" }}>Что-то пошло не так</h2>
            <p style={{ color: "var(--fg-2)", fontSize: "13px", marginBottom: "16px" }}>
              Произошла ошибка при загрузке компонента. Попробуй обновить страницу.
            </p>
            {this.state.error && (
              <details style={{ textAlign: "left", marginBottom: "16px" }}>
                <summary style={{ fontSize: "11px", color: "var(--text-muted)", cursor: "pointer" }}>
                  Детали ошибки
                </summary>
                <pre style={{ marginTop: "8px", fontSize: "11px", color: "var(--down)", background: "var(--on-accent)", borderRadius: "4px", padding: "12px", overflowX: "auto", fontFamily: "'JetBrains Mono', monospace" }}>
                  {this.state.error.message}
                </pre>
              </details>
            )}
            <button onClick={() => window.location.reload()} className="btn-primary">
              Обновить страницу
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
