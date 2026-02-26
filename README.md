# ai-writer

Local, single-user, multi-agent collaborative novel writing platform.

## Quick Start (Windows)

1) Put your API keys in `api.txt` (this file is **gitignored**).
2) Run:

```powershell
.\scripts\dev.ps1
```

This starts:
- API: http://localhost:8000
- Web: http://localhost:3000

## Smoke Test (LLM)

This project loads API keys from environment variables or local `api.txt` (gitignored).

Run a short, safe smoke test (<=500 chars output):

```powershell
.\apps\api\.venv\Scripts\python.exe .\apps\api\scripts\smoke_llm.py --provider openai
```

## Project Structure

- `apps/api` FastAPI backend
- `apps/web` Next.js frontend
- `scripts` local dev scripts
- `AGENTS.md` architecture + iteration notes

## Security

- Do not commit `api.txt` or `.env*` files.
- The app will never display full API keys in the UI.

## Notes

- Some OpenAI-compatible gateways may behave differently for certain reasoning models (e.g., empty text output).
  If you hit this, switch provider/model in `Settings`.
