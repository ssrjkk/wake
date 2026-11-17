"""Карточки @waketrade_bot для снимка в README.

Страницу собирают те же функции, которые отвечают в чате: `start_payload`,
`markets_payload`, `price_payload`, `funding_payload`, `spread_payload`. Числа
приходят из живого REST Lighter, рендер не дописывает ни строки — иначе подпись
«живые данные» относилась бы к картинке, а не к боту.

Запуск: python scripts/telegram-cards.py --out <файл.html>
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

# Значения по умолчанию — те, что живут в проде бота: кнопка ведёт на сайт,
# сеть mainnet. Если переменная уже задана, спорить с ней не будем.
os.environ.setdefault("WAKE_MINIAPP_URL", "https://wake-7k6.pages.dev")

import telegram_bot as tb  # noqa: E402  (после env — конфиг читается при импорте)

FONT = (ROOT / "node_modules" / "@fontsource-variable" / "jetbrains-mono" / "files").as_uri()
AZERET = (ROOT / "node_modules" / "@fontsource-variable" / "azeret-mono" / "files").as_uri()

CSS = f"""
@font-face {{ font-family: 'JetBrains Mono'; font-weight: 100 800;
  src: url('{FONT}jetbrains-mono-cyrillic-wght-normal.woff2') format('woff2-variations');
  unicode-range: U+0400-045F; }}
@font-face {{ font-family: 'JetBrains Mono'; font-weight: 100 800;
  src: url('{FONT}jetbrains-mono-latin-wght-normal.woff2') format('woff2-variations'); }}
@font-face {{ font-family: 'Azeret Mono'; font-weight: 100 800;
  src: url('{AZERET}azeret-mono-latin-wght-normal.woff2') format('woff2-variations'); }}
:root {{
  --bg-0: #0b0b0c; --bg-2: #161618; --bg-3: #1c1c1f;
  --line: #232326; --line-strong: #303035;
  --fg: #e6e6e8; --fg-2: #a0a0a7; --fg-3: #8f8f97; --accent: #ff6b35;
}}
* {{ box-sizing: border-box; }}
body {{ margin: 0; padding: 40px 40px 48px; width: 1240px; background: var(--bg-0);
  color: var(--fg); font-family: 'JetBrains Mono', ui-monospace, monospace; }}
h1 {{ font-family: 'Azeret Mono', ui-monospace, monospace; font-size: 20px;
  letter-spacing: .08em; margin: 0 0 6px; }}
.lead {{ color: var(--fg-3); font-size: 13px; margin: 0 0 28px; }}
section {{ margin: 0 0 26px; }}
.cmd {{ color: var(--accent); font-size: 13px; letter-spacing: .06em; margin: 0 0 8px; }}
.bubble {{ background: var(--bg-2); border: 1px solid var(--line); border-radius: 14px;
  padding: 16px 18px; max-width: 900px; }}
.bubble b {{ font-family: 'Azeret Mono', ui-monospace, monospace; font-size: 16px; }}
pre {{ font-family: inherit; font-size: 13.5px; line-height: 1.5; margin: 10px 0 0;
  color: var(--fg); white-space: pre; overflow: visible; }}
.note {{ color: var(--fg-2); font-size: 13px; margin-top: 10px; }}
a {{ color: var(--accent); text-decoration: none; }}
code {{ background: var(--bg-3); border: 1px solid var(--line); border-radius: 4px;
  padding: 1px 5px; font-size: 12.5px; }}
.keys {{ margin-top: 10px; display: flex; flex-direction: column; gap: 6px; max-width: 900px; }}
.krow {{ display: flex; gap: 6px; }}
.kbtn {{ flex: 1; text-align: center; background: var(--bg-3); border: 1px solid var(--line-strong);
  border-radius: 8px; padding: 9px 8px; font-size: 13px; color: var(--fg);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
a.kbtn {{ color: var(--accent); }}
"""


def to_browser(text: str) -> tuple[str, str]:
    """Telegram-HTML → браузерный. Переносы вне `<pre>` становятся `<br>`,
    потому что в чате их съедает разметка, а в таблице оборотов они и есть
    строки. Возвращает тело и сноску: сноска отделена пустой строкой."""
    head, _, rest = text.partition("\n\n")
    parts = re.split(r"(<pre>.*?</pre>)", head, flags=re.S)
    body = "".join(p if p.startswith("<pre>") else p.replace("\n", "<br>") for p in parts)
    note = ""
    if rest:
        note = "<div class=\"note\">" + rest.replace("\n", "<br>") + "</div>"
    return body + note, ""


def keyboard(markup) -> str:
    rows = getattr(markup, "inline_keyboard", None) or []
    if not rows:
        return ""
    out = ['<div class="keys">']
    for row in rows:
        out.append('<div class="krow">')
        for btn in row:
            text = (btn.text or "").replace("&", "&amp;").replace("<", "&lt;")
            url = getattr(btn, "url", None)
            out.append(
                f'<a class="kbtn" href="{url}">{text}</a>' if url else f'<span class="kbtn">{text}</span>'
            )
        out.append("</div>")
    out.append("</div>")
    return "".join(out)


async def build() -> str:
    cards = [
        ("/start", await tb.start_payload()),
        ("/markets", await tb.markets_payload()),
        ("/price BTC", await tb.price_payload("BTC")),
        ("/funding", await tb.funding_payload()),
        ("/spread BTC", await tb.spread_payload("BTC")),
    ]
    sections = []
    for cmd, (text, markup) in cards:
        body, _ = to_browser(text)
        sections.append(f"<section><p class=\"cmd\">{cmd}</p><div class=\"bubble\">{body}</div>{keyboard(markup)}</section>")
        title = (re.search(r"<b>(.*?)</b>", text) or re.search(r"<b></b>", ""))
        body_rows = re.search(r"<pre>(.*?)</pre>", text, flags=re.S)
        rows = len(body_rows.group(1).split("\n")) if body_rows else 0
        print(f"OK   {cmd:12} {title.group(1)[:44]:46} строк в теле: {rows}")
    return (
        "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><title>Wake bot cards</title>"
        f"<style>{CSS}</style></head><body>"
        "<h1>@waketrade_bot</h1>"
        "<p class=\"lead\">Ответы бота, собранные <code>backend/telegram_bot.py</code> на живых данных "
        "Lighter (mainnet) и отрисованные браузером. Ссылка в кнопке ведёт в Mini App того же сайта.</p>"
        + "".join(sections)
        + "</body></html>"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    Path(args.out).write_text(asyncio.run(build()), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
