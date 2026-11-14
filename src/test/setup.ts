// Интеграция jest-dom именно с vitest: подпуть /vitest расширяет expect() из
// vitest и дописывает его типы, поэтому `toHaveAttribute` проверяется компилятором,
// а не падает красным только в прогоне. Корневой импорт так не делает: matchers
// в нём регистрируются в обход типа Assertion, и тест, который должен был
// покраснеть на «атрибута нет», краснел бы на «такого метода нет».
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import { createChartStub } from './chartStub';

/* lightweight-charts рисует на canvas, а контекста 2d в jsdom нет: настоящая
   библиотека падала бы на монтировании каждой панели, до графика дело не доходит.
   Подменяется только createChart — перечисления и определения серий остаются
   библиотечными, иначе тест проверял бы заглушку, а не то, что библиотека
   принимает. Что легло в series.setData и что вернула подписка на перекрестие —
   читает src/components/PriceChart.test.tsx; пиксели проверяет Playwright. */
vi.mock('lightweight-charts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lightweight-charts')>();
  return {
    ...actual,
    createChart: (host: HTMLElement, options?: Record<string, unknown>) =>
      createChartStub(host, options ?? {}),
  };
});
