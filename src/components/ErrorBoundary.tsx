import React from "react";
import * as Sentry from "@sentry/react";
import { AlertTriangle } from "lucide-react";

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
        <div className="fallback-screen">
          <div className="fallback-card">
            <div className="fallback-mark">
              <AlertTriangle size={24} aria-hidden="true" />
            </div>
            <h2 className="section-title">Что-то пошло не так</h2>
            <p className="panel-lead">
              Произошла ошибка при загрузке компонента. Попробуй обновить страницу.
            </p>
            {this.state.error && (
              <details className="fallback-details">
                <summary className="label">Детали ошибки</summary>
                <pre className="fallback-trace">{this.state.error.message}</pre>
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
