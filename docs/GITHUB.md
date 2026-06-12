# GitHub Setup

The repository should be safe to push to `DhakadG/husky-drop` or a similarly
named repo.

## Files To Commit

- `src/`
- `public/`
- `scripts/`
- `docs/`
- `README.md`
- `package.json`
- `.gitignore`
- `wrangler.example.jsonc`

## Files To Keep Local

- `wrangler.jsonc`
- `.dev.vars`
- `.wrangler/`
- `node_modules/`
- any OAuth tokens or Cloudflare tokens

## Commands

```powershell
git init
git add .
git commit -m "feat: build losthusky dropbox"
gh repo create DhakadG/husky-drop --private --source=. --remote=origin --push
```

Use `--public` instead of `--private` only after checking the diff contains no
personal IDs or secrets.
