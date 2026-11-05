import { describe, it, expect } from 'vitest'
import { TABS, TAB_IDS } from './tabs'

// Список вкладок — единственный источник правды для навигации, горячих клавиш
// и ссылок `?tab=` из бота. Здесь проверяется сам список; сверка с App.tsx и с
// deeplink.ts (каждая вкладка имеет ветку рендера, ссылка бота принимает ровно
// эти значения) живёт в backend/test_api_contract.py, потому что читать
// исходники умеет тот прогон, а фронтендовые тесты не тянут node-типы.

describe('список вкладок', () => {
  it('идентификаторы уникальны и их ровно девять', () => {
    expect(new Set(TAB_IDS).size).toBe(TAB_IDS.length)
    // 9 — не косметика: обработчик Alt+1…Alt+9 в App.tsx физически не может
    // дать десятую клавишу, и молча выросший список потерял бы хоткеи.
    expect(TAB_IDS.length).toBe(9)
  })

  it('TAB_IDS — это ровно те же id, что в TABS, и в том же порядке', () => {
    expect(TAB_IDS).toEqual(TABS.map((t) => t.id))
  })

  it('каждая вкладка имеет непустую метку и иконку', () => {
    for (const tab of TABS) {
      expect(tab.label.trim().length, `метка вкладки ${tab.id}`).toBeGreaterThan(0)
      // lucide-react v1.61 отдаёт компоненты как forwardRef-объекты, а не
      // функции: сверять typeof === 'function' значило бы краснеть на
      // исправном коде. Важно, что иконка существует.
      expect(tab.icon, `иконка вкладки ${tab.id}`).toBeTruthy()
    }
  })

  it('флаг «читает публичный API» стоит только на существующих разделах', () => {
    const live = TABS.filter((t) => t.live).map((t) => t.id)
    expect(live.length).toBeGreaterThan(0)
    for (const id of live) {
      expect(TAB_IDS).toContain(id)
    }
  })
})
