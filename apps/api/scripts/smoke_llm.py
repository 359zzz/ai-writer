from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# Allow running this script from repo root (or anywhere) without installing the package.
_API_ROOT = Path(__file__).resolve().parents[1]  # .../apps/api
if str(_API_ROOT) not in sys.path:
    sys.path.insert(0, str(_API_ROOT))

from ai_writer_api.llm import LLMError, generate_text, resolve_llm_config
from ai_writer_api.secrets import secrets_status


async def _run(provider: str, max_tokens: int) -> int:
    print("[smoke] secrets:", secrets_status())

    settings = {
        "llm": {
            "provider": provider,
            "temperature": 0.2,
            "max_tokens": max_tokens,
        }
    }
    cfg = resolve_llm_config(settings)
    print(f"[smoke] provider={cfg.provider} model={cfg.model} base_url={cfg.base_url}")

    text = await generate_text(
        system_prompt="Return ONE short sentence only.",
        user_prompt="Say hello in <= 20 words.",
        cfg=cfg,
    )
    t = text.strip()
    print(f"[smoke] output_len={len(t)} head={t[:80]!r}")
    if len(t) > 500:
        raise RuntimeError("Output too long (>500 chars).")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default="openai", choices=["openai", "gemini"])
    ap.add_argument("--max-tokens", type=int, default=120)
    args = ap.parse_args()

    try:
        return asyncio.run(_run(args.provider, args.max_tokens))
    except LLMError as e:
        print(f"[smoke] LLMError: {e}")
        return 2
    except Exception as e:
        print(f"[smoke] Error: {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
