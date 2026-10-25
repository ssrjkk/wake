import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import type { LucideIcon } from "lucide-react";
import { pushLayer } from "../lib/layers";

// Content outside a native modal is inert, including its live-region notifications.
const ToastContext = createContext<ReactNode>(null);

export function ToastProvider({
  children,
  toast,
}: {
  children: ReactNode;
  toast: ReactNode;
}) {
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

// Стек открытых панелей живёт в lib/layers.ts; здесь только регистрация: модалка
// становится «верхним слоем» на время своей жизни в дереве.

export function Modal({
  children,
  label,
  onClose,
}: {
  children: ReactNode;
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const toast = useContext(ToastContext);

  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    // Начало фокуса задаём сами. Без этого браузер выбирает сам, а панель модалки
    // — прокручиваемый контейнер (max-h + overflow-y-auto), и Chrome отдаёт таким
    // контейнерам фокус: при длинном содержимом стартовый фокус попадал на обёртку,
    // а не на первую кнопку, и клавиатурный обход начинался с неочевидного места.
    (
      dialog.querySelector<HTMLElement>("[data-autofocus]") ??
      focusables(dialog)[0]
    )?.focus();
    return () => dialog.close();
  }, []);

  // onClose у вызывающих — стрелочная функция из рендера, поэтому в стек
  // кладётся стабильная обёртка со ссылкой: регистрация обязана пережить
  // перерисовку, иначе каждый рендер снимал бы панель и ставил бы её на вершину
  // заново, и порядок «что закрывать следующим» поехал бы.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => pushLayer(() => onCloseRef.current()), []);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      className="wake-modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
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

export function Skeleton({
  height = "16px",
  width = "100%",
}: {
  height?: string;
  width?: string;
}) {
  return <div className="skeleton" style={{ height, width }} />;
}

export function NavTab({
  active,
  onClick,
  label,
  live,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  live?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`nav-tab${active ? " nav-tab-active" : ""}`}
    >
      {/* Иконку показывает только нижняя панель (задаёт CSS): в строке подписей
          над контентом она была бы девятым украшением, а на телефоне по ней
          вкладка находится вслепую, когда текст уехал за край. */}
      {Icon && (
        <Icon
          className="tab-icon"
          size={15}
          strokeWidth={1.9}
          aria-hidden="true"
        />
      )}
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
