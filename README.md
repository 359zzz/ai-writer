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

## Project Structure

- `apps/api` FastAPI backend
- `apps/web` Next.js frontend
- `scripts` local dev scripts
- `AGENTS.md` architecture + iteration notes

## Security

- Do not commit `api.txt` or `.env*` files.
- The app will never display full API keys in the UI.

