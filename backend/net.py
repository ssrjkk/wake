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
чужой. Из цепочки берётся правый адрес: его дописал прокси, который видел
соединение, а всё левее этого элемента клиент мог подставить сам.
"""

from fastapi import Request

from config import TRUSTED_PROXY_IPS


def client_ip(request: Request) -> str:
    """IP пользователя для аудита и ключа rate limit. Без доверенного прокси —
    адрес соединения, чем бы он ни оказался."""
    peer = request.client.host if request.client else ""
    if peer not in TRUSTED_PROXY_IPS:
        return peer or "unknown"
    chain = [
        part.strip() for part in request.headers.get("x-forwarded-for", "").split(",")
    ]
    chain = [value for value in chain if value]
    return chain[-1] if chain else peer
