# API 契約 (`/api/v1/*`)

> **正本**: 各エンドポイントの厳密な型は `apps/api/app/schemas/*.py` を参照。
> `packages/shared/jsonschema/*.json` が JSON Schema 抜粋を保持する。

## 認証

- `Authorization: Bearer <jwt>` (一部のエンドポイントのみ必須、`/me/*` 等)
- JWT は HS256、`AUTH_SECRET` で署名
- 有効期限: User JWT 30 日 / Exchange JWT 60 秒
- フローは [`architecture.md`](./architecture.md#データフロー) を参照

## エンドポイント一覧

| Method | Path | 認証 | 概要 |
|--------|------|-----|------|
| GET | `/api/v1/health` | - | ヘルスチェック (`{"status":"ok"}`) |
| GET | `/api/v1/feed` | - | 縦スクロール用カーソル付きフィード |
| GET | `/api/v1/movies/{slug}` | - | 作品詳細 |
| GET | `/api/v1/movies/{slug}/resolve-mp4` | - | MP4 サンプル URL の動的解決（resolver 経由、`?force=true` でキャッシュバイパス） |
| DELETE | `/api/v1/movies/{slug}/sample-url` | - | DB 上の `sample_movie_url` を NULL に戻す。クライアントの self-heal 用（204 No Content） |
| GET | `/api/v1/search` | - | 検索 (キーワード / フィルタ) |
| GET | `/api/v1/tags` | - | ジャンル一覧 |
| GET | `/api/v1/rankings` | - | `?period=daily\|weekly\|monthly` |
| GET | `/api/v1/home` | - | トップ画面集約 (本日新着 / 人気 / ランキング / 検索数高ジャンル) |
| GET | `/api/v1/actresses/{name}` | - | 女優プロフィール＋出演作 |
| POST | `/api/v1/events` | - | 計測イベント記録 (レート制限あり) |
| POST | `/api/v1/auth/sign-in` | - | exchange JWT → user JWT に交換 |
| GET | `/api/v1/me/bookmarks` | ✓ | ブックマーク一覧 |
| POST | `/api/v1/me/bookmarks` | ✓ | ブックマーク追加 |
| DELETE | `/api/v1/me/bookmarks/{movie_id}` | ✓ | ブックマーク削除 |
| GET | `/api/v1/me/history` | ✓ | 視聴履歴 |

## イベント種別

`apps/api/app/repositories/event_repository.py::ALLOWED_EVENT_TYPES`:

```
view / play / affiliate_click / search / share / favorite_add / favorite_remove
```

- `search` イベントは `search_query` 必須
- それ以外は `slug` 必須
- レート制限: `EVENTS_RATE_LIMIT_PER_SECOND=10` / `EVENTS_RATE_LIMIT_PER_MINUTE=120` (IP ベースの sliding window)

## エラー応答

```json
{ "detail": "<message>" }
```

| HTTP | 意味 |
|------|------|
| 400 | バリデーション失敗 (例: invalid event_type) |
| 401 | 認証失敗 / JWT 検証エラー |
| 404 | リソース未存在 (slug 等) |
| 429 | レート制限超過 (events) |
| 500 | 内部エラー (ログ確認) |

## 互換性ポリシー

- v1 を破壊変更する場合は **`/api/v2` を新設** する。既存 `/api/v1` は最低 1 月並走。
- レスポンスフィールドの追加は破壊変更ではない。型変更・削除は破壊変更。
