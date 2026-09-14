# Repo + delivery setup

Use these commands once you want this to be a private GitHub repo named `bean`:

```bash
cd /path/to/bean
git init
git add .
git commit -m "init: build floating Claude companion with accessibility observer"
git branch -M main
gh repo create bean --private --source . --remote origin --push
```

If you want to publish test artifacts in GitHub:

- Keep workflow file at `.github/workflows/build-dmg.yml`
- Set `actions/upload-artifact` retention defaults
- Run Actions manually (`workflow_dispatch`) for both architectures

For local mac test build:

```bash
npm install
npm run build
cd src-tauri
tauri build
```
