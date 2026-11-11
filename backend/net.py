"""
Откуда на самом деле пришёл запрос, когда перед приложением стоит прокси.

На Railway и Cloudflare соединение всегда приходит от прокси, поэтому
request.client.host — адрес прокси, а не пользователя. Записывать его в аудит
или строить из него ключ rate limit — значит получить одну запись «10.0.0.1» на
всю аудиторию и один общий bucket на весь сервис: один активный клиент закрит
бы всех остальных.

X-Forwarded-For читается только когда соединение реально пришло из
WAKE_TRUSTED_PROXY_IPS. Сама по себе эта строка пишется клиентом как ему
вздумается, и доверять ей без проверки источника — способ выдать свой IP за
чужой. Из цепочки берётся самый правый адрес, которого нет в списке доверенных:
его дописал последний прокси, видевший соединение с клиентом, а всё левее мог
подставить кто угодно.

Список доверенных и адреса из заголовка сравниваются как IP, а не как строки:
`ipaddress` сводит регистр, свёрнутую и развёрнутую запись IPv6 и форму
`::ffff:a.b.c.d` (её даёт dual-stack сокет) к одному значению. Строковое
сравнение молча расцепляет «доверенный прокси» с самим собой — а это ровно тот
исход, из-за которого модуль и написан: один общий bucket и одна запись в
аудите на всю аудиторию, без ошибки в логе.
"""

from ipaddress import ip_address

from fastapi import Request

from config import TRUSTED_PROXY_IPS


def canonical_ip(value: str) -> str:
    """Адрес в форме, в какой его можно сравнивать и ключевать. Всё, что IP не
    является (имя хоста, мусор из заголовка), возвращается stripped-lowercased
    как есть: решение «доверенный/нет» остаётся за сравнением, а не за тем,
    распарсился ли адрес."""
    text = value.strip().lower()
    # Скобки и порт после них — оформление URL, а не адрес: в заголовках IPv6
    # приезжает именно `[2001:db8::1]:443`.
    if text.startswith("["):
        text = text[1:].partition("]")[0]
    try:
        addr = ip_address(text)
    except ValueError:
        # Единственное «:», после которого только цифры, у IP-литеры быть не
        # может — значит это IPv4 с портом, а не свёрнутый IPv6.
        head, sep, port = text.rpartition(":")
        if sep and port.isdigit():
            try:
                addr = ip_address(head)
            except ValueError:
                return text
        else:
            return text
    return str(getattr(addr, "ipv4_mapped", None) or addr)


def client_ip(request: Request) -> str:
    """IP пользователя для аудита и ключа rate limit. Без доверенного прокси —
    адрес соединения, чем бы он ни оказался.

    Из цепочки X-Forwarded-For берётся самый правый НЕдоверенный адрес, а не
    просто правый. Правило «правый дописал прокси» верно ровно для одного прокси
    перед приложением; в настоящей цепи (браузер → Cloudflare → Railway → app)
    правый элемент — это адрес предыдущего прокси, то есть весь аудит и всё
    ведро лимитера жили бы на одном IP Cloudflare. Идём справа налево и
    пропускаем всё, что входит в WAKE_TRUSTED_PROXY_IPS: остальные адреса в
    цепочке дописывали те, кому мы не доверяем, но последний недоверенный —
    это и есть ближайший к нам клиент."""
    trusted = {canonical_ip(value) for value in TRUSTED_PROXY_IPS}
    peer = canonical_ip(request.client.host if request.client else "")
    if peer not in trusted:
        return peer or "unknown"
    chain = [
        canonical_ip(part)
        for part in request.headers.get("x-forwarded-for", "").split(",")
    ]
    for value in reversed([part for part in chain if part]):
        if value not in trusted:
            return value
    return peer
