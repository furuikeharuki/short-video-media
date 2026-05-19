# apps/web

Next.js 15 + Auth.js v5 によるフロントエンド。Vercel にデプロイ。

## 主要機能

- **縦スクロール再生フィード**: TikTok 風 UX (`app/feed/page.tsx`)
- **作品詳細モーダル**: Next.js parallel routes (`@modal/(.)movies/[slug]`)
- **検索フィード**: 検索結果も縦スクロール再生可能 (`/search/feed`)
- **女優詳細**: `/actresses/[name]` でプロフィール＋出演作
- **マイページ**: ブックマーク / 視聴履歴 (要ログイン)
- **OAuth ログイン**: Twitter / Discord (Auth.js v5)
- **法務ページ**: `/privacy` / `/law` / `/contact`

## ローカル開発

```bash
# 環境変数 (リポジトリルートの .env.example 参照)
cp ../../.env.example .env.local

# 開発サーバー
pnpm dev   # http://localhost:3000

# 型チェック
pnpm typecheck

# ビルド
pnpm build
```

## アーキテクチャの注意点

- **API 接続**: `lib/api/*.ts` 経由で `${API_BASE_URL}/api/v1/*` を叩く
- **/me 系のプロキシ**: `app/api/proxy/me/[...path]/route.ts` が JWT 付与＋ Content-Type 正規化を担当 (`force-dynamic` 必須)
- **計測**: `lib/analytics/analytics.ts` の `trackEvent()` を使う。GA4 + バックエンド `/api/v1/events` の二系統に同時送信される
- **認証フロー**: Auth.js → callback で provider sub を取得 → API の `/auth/sign-in` に exchange JWT を渡して User JWT を取得 → cookie に保存

## デプロイ

main への push で Vercel が自動デプロイ。プレビュー環境は PR ごとに自動生成。

## 関連ドキュメント

- [`../../docs/api-contract.md`](../../docs/api-contract.md)
- [`../../docs/architecture.md`](../../docs/architecture.md)
