// Стек открытых панелей (модалок). Нужен не ради счётчика, а ради одного вопроса:
// «что закрывать следующим» там, где спрашивающий не знает списка модалок.
//
// Показательный случай — Telegram-мини-апп: кнопка «назад» у него одна на всё
// окно, а панели торгов разделов (подтверждение ордера, окно Predict, выбор
// рынка) смонтированы внутри своих вкладок, и App.tsx про них ничего не знает.
// Без стека «назад» закрывал бы только то, что открыл сам App, а на самой важной
// панели — подтверждении ордера — вёл бы сразу к выходу из мини-аппа.
//
// Отдельный модуль, а не часть ui.tsx: тот файл должен оставаться одними
// компонентами (react-refresh), а тут — порядок регистрации и больше ничего.

type Layer = { close: () => void };

const layers: Layer[] = [];
const listeners = new Set<(depth: number) => void>();

function announce() {
  for (const listener of listeners) listener(layers.length);
}

/** Поставить панель на верх стека. Возвращает снятие: панель обязана убрать
 * себя сама, иначе «назад» вызывало бы onClose уже размонтированного компонента. */
export function pushLayer(close: () => void): () => void {
  const layer = { close };
  layers.push(layer);
  announce();
  return () => {
    const at = layers.lastIndexOf(layer);
    if (at >= 0) layers.splice(at, 1);
    announce();
  };
}

/** Закрыть верхнюю панель. false — закрывать нечего, и «назад» тогда принадлежит
 * приложению (меню профиля), а не стеку. */
export function closeTopLayer(): boolean {
  const top = layers[layers.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function onLayerDepth(listener: (depth: number) => void): () => void {
  listeners.add(listener);
  listener(layers.length);
  return () => listeners.delete(listener);
}
