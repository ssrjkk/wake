import { describe, it, expect, vi, afterEach } from 'vitest'
import { closeTopLayer, onLayerDepth, pushLayer } from './layers'

// Стек держит порядок закрытия для того, кто не знает списка панелей: кнопка
// «назад» Telegram-мини-аппа одна на всё окно, а модалки живут внутри своих
// вкладок. Поэтому здесь проверяется порядок, а не сам факт вызова.
// close() только просит закрыть: панель уходит из стека при размонтировании, то
// есть когда срабатывает её собственное снятие. Тесты моделируют это явно.
let detachers: (() => void)[] = []

function open(close: () => void) {
  const detach = pushLayer(close)
  detachers.push(detach)
  return detach
}

afterEach(() => {
  // Стек модульный: без очистки каждый следующий тест стартовал бы с чужими
  // панелями и глубина читалась бы неверно.
  for (const detach of detachers.reverse()) detach()
  detachers = []
  expect(closeTopLayer()).toBe(false)
})

describe('layer stack', () => {
  it('closes the most recently opened panel first', () => {
    const closed: string[] = []
    const detachFirst = open(() => closed.push('первая'))
    const detachSecond = open(() => closed.push('вторая'))

    expect(closeTopLayer()).toBe(true)
    detachSecond()
    expect(closeTopLayer()).toBe(true)
    detachFirst()

    expect(closed).toEqual(['вторая', 'первая'])
  })

  it('says there is nothing to close, so the caller handles its own layer', () => {
    // false — сигнал приложению закрыть то, что стеку не принадлежит: меню
    // профиля, например. Молчаливый «успех» здесь означал бы, что «назад»
    // ничего не сделала и человек не понял, почему.
    expect(closeTopLayer()).toBe(false)

    const detach = open(() => {})
    expect(closeTopLayer()).toBe(true)
    detach()
  })

  it('removes exactly the panel that detached', () => {
    const closed: string[] = []
    const detachFirst = open(() => closed.push('первая'))
    open(() => closed.push('вторая'))

    // Снятие убирает панель по её месту в стеке, а не последнюю: иначе закрытие
    // первой модалки тайком снимало бы со «второй» её onClose, и «назад» бил бы
    // в пустоту.
    detachFirst()
    expect(closeTopLayer()).toBe(true)
    expect(closed).toEqual(['вторая'])
  })

  it('ignores a detach that already happened', () => {
    const detach = open(() => {})
    detach()
    expect(() => detach()).not.toThrow()
  })

  it('reports the depth on subscribe and on every change', () => {
    const seen: number[] = []
    const unsubscribe = onLayerDepth((depth) => seen.push(depth))
    const detach = open(() => {})
    detach()
    unsubscribe()

    expect(seen).toEqual([0, 1, 0])
  })

  it('stops reporting after unsubscribe', () => {
    const listener = vi.fn()
    onLayerDepth(listener)()
    listener.mockClear()

    open(() => {})()
    expect(listener).not.toHaveBeenCalled()
  })
})
