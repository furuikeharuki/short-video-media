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

## 広告 (ExoClick)

ExoClick の 4 種類の zone を、独立した環境変数で ON/OFF できる形で実装している。
全体スイッチ `NEXT_PUBLIC_ADS_ENABLED=true` と、各 zone 個別の `NEXT_PUBLIC_AD_*_ENABLED=true`
の両方が真のときだけ DOM に出る。すべてデフォルト OFF。

| zone                          | env (個別)                                            | 配置場所                                  | zoneid env                                              | デフォルト zoneid |
|-------------------------------|--------------------------------------------------------|-------------------------------------------|---------------------------------------------------------|-------------------|
| Native Recommendation         | `NEXT_PUBLIC_AD_NATIVE_ENABLED`                        | 作品詳細ページ下部 / 女優詳細ページ下部 | `NEXT_PUBLIC_EXOCLICK_NATIVE_ZONE_ID`                  | `5929928`         |
| Mobile Banner 300×250         | `NEXT_PUBLIC_AD_MOBILE_BANNER_300X250_ENABLED`         | 一覧 / 検索結果に N 件ごと挟む            | `NEXT_PUBLIC_EXOCLICK_MOBILE_BANNER_300X250_ZONE_ID`   | `5929910`         |
| Mobile Banner 300×100         | `NEXT_PUBLIC_AD_MOBILE_BANNER_300X100_ENABLED`         | ホームのセクション間 (3 セクションごと)   | `NEXT_PUBLIC_EXOCLICK_MOBILE_BANNER_300X100_ZONE_ID`   | `5929930`         |
| Mobile Fullpage Interstitial  | `NEXT_PUBLIC_AD_FULLPAGE_INTERSTITIAL_ENABLED`         | 全ページ (A/B 用、セッション 1 回のみ)    | `NEXT_PUBLIC_EXOCLICK_FULLPAGE_INTERSTITIAL_ZONE_ID`   | `5929932`         |

挿入頻度の調整:

- `NEXT_PUBLIC_AD_LIST_INTERVAL` (デフォルト `6`): /list/[key] と /search 結果のグリッドで N 件ごとに 300×250 を 1 行全幅で挟む。
- `NEXT_PUBLIC_AD_FEED_INTERVAL` (デフォルト `10`): 縦スクロール /feed 内のネイティブ広告カード用 (現状 UI/UX 保護のため未挿入の予約値)。

実装ファイル:

- `lib/ads/config.ts` — 環境変数の集約。
- `components/ads/AdScriptLoader.ts` — `a.magsrv.com` / `a.pemsrv.com` の `ad-provider.js` を provider 単位で 1 回だけロード。
- `components/ads/AdSlot.tsx` — 個別広告枠。`enabled` が false の zone は何も描画しない。CLS 抑止のため reservedHeight を確保。
- `components/ads/FullpageInterstitial.tsx` — レイアウト最上位に置く 1 回起動の interstitial トリガー。`sessionStorage` で 1 セッション 1 回に制限。

直近で revert したフィード上部固定広告は復活させていない。/feed の縦スワイプ動画体験は触らず、ホーム / 一覧 / 検索 / 詳細 / 女優ページのスクロール領域だけに広告を出す。

## デプロイ

main への push で Vercel が自動デプロイ。プレビュー環境は PR ごとに自動生成。

## 関連ドキュメント

- [`../../docs/api-contract.md`](../../docs/api-contract.md)
- [`../../docs/architecture.md`](../../docs/architecture.md)
