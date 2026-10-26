// Окно строк: в DOM живёт только то, что видно, плюс запас сверху и снизу.
//
// Повод появиться — замер, а не вкус: окно выбора рынка mounted 200 кнопок и
// открывалось за 615 мс (книга Lighter отдаёт 246 строк, активных 226), а
// журнал копи-движка рендерил 200 строк таблицы и делал страницу в 10 317 px.
// Список — не «несколько строк», а тысячи узлов, и платит за это каждый
// keystroke поиска и каждый опрос.
//
// attach отдаётся наружу колбэком, а не RefObject, и это не красота: эффект
// обязан перезапуститься в момент, когда контейнер ПОЯВИЛСЯ. С обычным ref'ом
// открытие модалки не меняет ни одного deps-значения, эффект не перезапускался,
// и окно оставалось в состоянии «измерить было нечем» — пустой список.
//
// Высота строки задаётся вызывающим кодом и обязана быть одинаковой: окно
// считает позиции арифметикой, а не измеряет каждую строку.
import { useCallback, useEffect, useState } from "react";

export type RowWindow = {
  /** Индекс первой строки в окне. */
  start: number;
  /** Индекс после последней строки окна. */
  end: number;
  /** Высота, которую надо оставить над окном. */
  padTop: number;
  /** Высота, которую надо оставить под окном. */
  padBottom: number;
};

export type WindowedList<Element extends HTMLElement> = RowWindow & {
  /** Ставится на прокручиваемый контейнер: он и задаёт видимую высоту. */
  attach: (node: Element | null) => void;
};

// Вызов деструктурируют — `const { attach, ...window } = useRowWindow(...)`.
// Валидатор react-hooks считает объект, который попадает в `ref=`, ссылкой и
// запрещает читать его свойства во время рендера; здесь это обычные числа из
// state, и правило их не видит. Разделяют их поэтому в месте вызова.

/** Запасная высота видимой области до первого измерения.
 *
 * Пока контейнер не появился, настоящее clientHeight неизвестно, и «полное
 * окно» в этот момент означало бы, что первый кадр модалки смонтирует все 246
 * строк и только потом сожмётся до окна: замер открытия — 413 мс против 40 мс
 * с этим запасом. 400 px — порядок высоты реального списка (.picker-list). */
const FALLBACK_VIEWPORT_PX = 400;

type Viewport = { node: Element; scrollTop: number; height: number };

const windowFrom = (
  count: number,
  rowHeight: number,
  overscan: number,
  viewport: Viewport | null,
): RowWindow => {
  const height = viewport?.height ?? FALLBACK_VIEWPORT_PX;
  const first = Math.floor((viewport?.scrollTop ?? 0) / rowHeight);
  const visible = Math.ceil(height / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan * 2);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (count - end) * rowHeight),
  };
};

const full = (count: number): RowWindow => ({
  start: 0,
  end: count,
  padTop: 0,
  padBottom: 0,
});

export function useRowWindow<Element extends HTMLElement>(
  count: number,
  rowHeight: number,
  overscan = 4,
): WindowedList<Element> {
  const [node, setNode] = useState<Element | null>(null);
  // Замер привязан к конкретному узлу: список пересоздаётся при каждом открытии
  // модалки, а прошлые числа (scrollTop из предыдущего просмотра) не должны
  // пережить его ни на один кадр.
  const [measured, setMeasured] = useState<Viewport | null>(null);

  useEffect(() => {
    if (!node) return;
    // Единственный источник чисел — события внешней системы (скролл и
    // ResizeObserver). Первичный замер делает сам наблюдатель: по спецификации
    // первый вызов приходит в том же кадре, перед отрисовкой, поэтому
    // «состояния ещё не измерено» видно не бывает.
    const sync = () =>
      setMeasured({ node, scrollTop: node.scrollTop, height: node.clientHeight });
    node.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [node]);

  const attach = useCallback((next: Element | null) => setNode(next), []);

  const viewport = measured && measured.node === node ? measured : null;
  const rowWindow = windowFrom(count, rowHeight, overscan, viewport);

  // Всё, что влезает, — влезает: иначе под коротким списком padBottom рисовал бы
  // пустоту там, где пустоты нет.
  return {
    attach,
    ...(count <= rowWindow.end - rowWindow.start ? full(count) : rowWindow),
  };
}
