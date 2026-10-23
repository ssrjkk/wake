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
"""

from fastapi import Request

from config import TRUSTED_PROXY_IPS


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
    peer = request.client.host if request.client else ""
    if peer not in TRUSTED_PROXY_IPS:
        return peer or "unknown"
    chain = [
        part.strip() for part in request.headers.get("x-forwarded-for", "").split(",")
    ]
    chain = [value for value in chain if value]
    for value in reversed(chain):
        if value not in TRUSTED_PROXY_IPS:
            return value
    return peer
