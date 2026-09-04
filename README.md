# reeldev.jp — Riel Hosiduki Personal Site

スクロールで深海に潜るコンセプトのポートフォリオサイト。

## 構成

```
reeldev/
├── frontend/          # Nginx 静的サイト (HTML/CSS/JS)
├── backend/           # Express API (SQLite + Qiita proxy)
├── admin/             # 管理画面 (Discord OAuth)
├── k8s/base/          # Kubernetes マニフェスト
└── .github/workflows/ # GitHub Actions CI/CD
```

## ページ構成

| パス      | 内容                         |
|-----------|------------------------------|
| `/`       | Hero + セクションプレビュー  |
| `/news`   | お知らせ一覧・詳細           |
| `/about`  | プロフィール・スキル・経歴   |
| `/tech`   | 技術スタック + Qiita 記事    |
| `/sns`    | SNS・リンク一覧              |
| `/thanks` | 謝辞                         |

## インフラ構成

```
Internet
  │ HTTPS (Let's Encrypt via Traefik)
  ▼
k3s cluster (CP×1 + WK×1)
  ├─ traefik (IngressRoute)
  │    ├─ reeldev.jp         → frontend-service:80
  │    ├─ reeldev.jp/api/*   → api-service:3001
  │    └─ admin.reeldev.jp   → admin-service:3002
  │
  ├─ frontend  (Nginx, ghcr.io/…/reeldev-frontend:latest)
  ├─ api       (Express+SQLite, ghcr.io/…/reeldev-backend:latest)
  ├─ admin     (Express, ghcr.io/…/reeldev-admin:latest)
  └─ CronJob   qiita-refresh (毎日 04:00 UTC)

ArgoCD が k8s/base/ を監視 → git push で自動 sync
```

## セットアップ手順

### 1. リポジトリ準備

```bash
git clone https://github.com/OWNER/reeldev
# deployments.yaml の OWNER を自分の GitHub ユーザ名に置換
sed -i 's/OWNER/your-github-username/g' k8s/base/deployments.yaml
sed -i 's/OWNER/your-github-username/g' k8s/argocd-app.yaml
```

### 2. Secrets 投入

```bash
# 詳細は k8s/base/secrets-template.yaml 参照
kubectl create secret generic reeldev-secrets -n reeldev \
  --from-literal=ADMIN_API_KEY='...' \
  --from-literal=SESSION_SECRET='...' \
  --from-literal=DISCORD_CLIENT_ID='...' \
  --from-literal=DISCORD_CLIENT_SECRET='...' \
  --from-literal=DISCORD_REDIRECT_URI='https://admin.reeldev.jp/auth/callback' \
  --from-literal=ALLOWED_DISCORD_IDS='<your-discord-user-id>'

kubectl create secret docker-registry ghcr-secret -n reeldev \
  --docker-server=ghcr.io \
  --docker-username=<github-user> \
  --docker-password=<github-pat>
```

### 3. GitHub Actions Secrets

| Secret名            | 内容                           |
|---------------------|--------------------------------|
| `ARGOCD_SERVER`     | ArgoCD の URL (https://…)      |
| `ARGOCD_TOKEN`      | ArgoCD API トークン            |

### 4. ArgoCD Application 登録

```bash
kubectl apply -f k8s/argocd-app.yaml
```

### 5. Discord アプリ設定

Discord Developer Portal → New Application
- OAuth2 → Redirects に `https://admin.reeldev.jp/auth/callback` 追加
- Bot は不要 (identify スコープのみ)
- ユーザIDは開発者モードで右クリック → IDをコピー

## タグ戦略（コミット数増加抑制）

- `main` push → `:latest` (上書き) + `:YYYYMMDD-<sha>` (日次タグ)
- `v*.*.*` タグ push → `:vX.Y.Z` のみ
- ArgoCD は `imageTag: latest` を参照 → イメージハッシュ変化で自動更新
- 日次タグは週1の cleanup job で 10件を超えたら古いものを削除

## ローカル開発

```bash
# Backend
cd backend && npm install && node src/server.js

# Admin
cd admin && npm install && node src/server.js

# Frontend — ブラウザで直接開く
open frontend/src/index.html
```

## Copyright
©reel hosiduki 2026 all rights reserved
