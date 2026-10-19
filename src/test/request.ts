// Единственный способ отправить тело в бэкенд — JSON.stringify в lib/backend.ts,
// поэтому в тестах здесь всегда строка. String() от объекта дал бы '[object Object]',
// и сравнение с ожидаемым JSON прошло бы, не проверив ничего; вместо этого бросаем.
export function jsonBody(init?: RequestInit): unknown {
  const body = init?.body
  if (typeof body !== 'string') throw new Error(`тело запроса не строка: получено ${typeof body}`)
  return JSON.parse(body) as unknown
}
