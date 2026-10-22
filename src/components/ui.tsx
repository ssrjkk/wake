import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";

// Content outside a native modal is inert, including its live-region notifications.
const ToastContext = createContext<ReactNode>(null);

export function ToastProvider({ children, toast }: { children: ReactNode; toast: ReactNode }) {
  return <ToastContext value={toast}>{children}</ToastContext>;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"])';

/** Видимые focusable внутри диалога, в порядке обхода. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (control) => control.getClientRects().length > 0,
  );
}

export function Modal({ children, label, onClose }: { children: ReactNode; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const toast = useContext(ToastContext);

  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    // Начало фокуса задаём сами. Без этого браузер выбирает сам, а панель модалки
    // — прокручиваемый контейнер (max-h + overflow-y-auto), и Chrome отдаёт таким
    // контейнерам фокус: при длинном содержимом стартовый фокус попадал на обёртку,
    // а не на первую кнопку, и клавиатурный обход начинался с неочевидного места.
    (dialog.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(dialog)[0])?.focus();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      className="wake-modal"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = focusables(event.currentTarget);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      {children}
      {toast}
    </dialog>
  );
}

export function Skeleton({ height = "16px", width = "100%" }: { height?: string; width?: string }) {
  return <div style={{ height, width, background: "#1a1a1a", borderRadius: "3px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />;
}

export function NavTab({ active, onClick, label, live }: { active: boolean; onClick: () => void; label: string; live?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`nav-tab${active ? " nav-tab-active" : ""}`}
    >
      {label}
      {live && (
        <span
          aria-hidden="true"
          className="live-indicator"
          title="Данные обновляются без бэкенда Wake"
        />
      )}
    </button>
  );
}
