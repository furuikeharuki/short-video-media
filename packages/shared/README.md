# @short-video-media/shared

`apps/web` (Next.js) と `apps/api` (FastAPI) の間で共有するスキーマ・型定義の最小セット。

## 構成

```
packages/shared/
├── jsonschema/          # JSON Schema (Draft 2020-12)
│   ├── feed.schema.json
│   ├── movie.schema.json
│   └── search.schema.json
└── ts/                  # TypeScript 型 (web 側からの import 用)
    ├── api.ts           # エンドポイント定数
    ├── feed.ts
    ├── movie.ts
    └── search.ts
```

## 運用方針

- **真のソース** (Source of Truth) は `apps/api` の Pydantic スキーマ (`apps/api/app/schemas/*.py`)。
- `jsonschema/*.json` は手動で v1 を作成し、API スキーマを変更した際に同時に更新する。
- `ts/*.ts` は `apps/web/lib/api/*.ts` で定義済みの型と整合するように再エクスポートで構成する。重複定義を増やしすぎないため、初期は薄く保つ。
- 将来、Pydantic v2 の `model_json_schema()` を使った自動生成スクリプトに置き換える予定 (`scripts/generate-schemas.ts`)。

## ライセンス

このパッケージはモノレポ内部利用のみで、外部公開はしない。
