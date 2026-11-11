import { describe, it, expect } from 'vitest'
import { BACKEND_URL } from './config'
import { isLoopbackBackend, loopbackBuildProblem } from './loopback'

// Правило одно, а спрашивают про него два места: текст ошибки в панели и
// боевая сборка. Тесты в backend.test.ts выбирают ветку по адресу сборки и
// потому проверяют только одну из них — здесь решает сама функция.
describe('isLoopbackBackend', () => {
  const LOOPBACK = [
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://127.0.0.2:8000', // весь 127.0.0.0/8 — петля, а не только .1
    'http://[::1]:8000',
    'http://[0:0:0:0:0:0:0:1]:8000', // та же ::1 в развёрнутой записи
    'HTTP://LOCALHOST:8000',
    'https://localhost',
    // Форма без схемы — так переменную записывают руками, и именно на ней
    // прежний разбор молчал: `new URL('localhost:8787')` даёт схему
    // «localhost:» и пустой hostname, то есть «это не петля» на адрес самой
    // машины. Цена — боевой бандл, где каждый посетитель стучится к себе.
    'localhost:8787',
    '127.0.0.1:8000',
    '[::1]:8787',
    'localhost',
  ]
  const PUBLIC = [
    BACKEND_URL, // адрес этой сборки: на нём панель обязана называть адрес
    'https://wake.example.com/localhost',
    'https://api.localhost.example.com',
    'https://wake.example.com?callback=http://127.0.0.1:8000',
    'http://localhost.attacker.tld', // суффикс «.attacker.tld» имя не отменяет
    'http://localhostish:9',
    'localhost:8787.evil.com',
    '',
    'не адрес',
    '/api',
  ]

  it.each(LOOPBACK)('calls %s the machine itself', (url) => {
    expect(isLoopbackBackend(url)).toBe(true)
  })

  it.each(PUBLIC)('calls %s not the machine', (url) => {
    expect(isLoopbackBackend(url)).toBe(false)
  })

  // Наивная проверка — «в строке есть localhost или 127.0.0.1» — краснеет ровно
  // на этих строках: она не видит `[::1]` и `127.0.0.2` и записывает в петлю
  // публичный адрес, у которого слово localhost стоит в пути или в query.
  it('reads the host, not the substring', () => {
    const naive = (url: string) => url.includes('localhost') || url.includes('127.0.0.1')
    for (const url of ['http://[::1]:8000', 'http://127.0.0.2:8000', 'HTTP://LOCALHOST:8000']) {
      expect(naive(url)).toBe(false)
      expect(isLoopbackBackend(url)).toBe(true)
    }
    for (const url of ['https://wake.example.com/localhost', 'https://api.localhost.example.com']) {
      expect(naive(url)).toBe(true)
      expect(isLoopbackBackend(url)).toBe(false)
    }
  })
})

// Сборка — то место, где ошибка правила стоит всего дороже: бандл с петлёй
// уезжает на прод молча, и разница с настоящим простоем бэкенда видна только
// в самом бандле. Здесь тот же предикат, что в панели, но с другой ценой.
describe('loopbackBuildProblem', () => {
  it('refuses every spelling of the machine in a production build', () => {
    for (const url of ['http://localhost:8000', 'http://127.0.0.2:8000', 'http://[::1]:8000']) {
      const problem = loopbackBuildProblem('production', url)
      expect(problem, url).not.toBeNull()
      expect(problem, url).toContain(url)
    }
  })

  it('lets the deployed address build', () => {
    expect(loopbackBuildProblem('production', BACKEND_URL)).toBeNull()
  })

  // Dev-сервер с петлёй — штатная локальная разработка (frontend в
  // docker-compose именно так и стартует), поэтому правило не про него.
  it('says nothing outside a production build', () => {
    expect(loopbackBuildProblem('development', 'http://localhost:8000')).toBeNull()
  })

  // Пустое значение — «сборка без .env», то есть дефолт из config.ts, а не
  // петля: отказывать на нём значило бы ломать CI-сборку без причины.
  it('says nothing when the variable is absent', () => {
    expect(loopbackBuildProblem('production', undefined)).toBeNull()
    expect(loopbackBuildProblem('production', '')).toBeNull()
  })

  // Регулярка по строке URL — то, чем это правило было до разбора хоста. Она
  // пропускала 127.0.0.2, LOCALHOST и развёрнутую запись ::1, то есть ровно
  // те бандлы, которые уехали бы на прод.
  it('is not the regex it replaced', () => {
    const naive = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/
    for (const url of ['http://127.0.0.2:8000', 'HTTP://LOCALHOST:8000', 'http://[0:0:0:0:0:0:0:1]:8000']) {
      expect(naive.test(url), url).toBe(false)
      expect(loopbackBuildProblem('production', url), url).not.toBeNull()
    }
  })
})
