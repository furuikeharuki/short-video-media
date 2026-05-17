# ロードマップ

> 詳細は [`requirements_definition_v5_0.md`](./requirements_definition_v5_0.md) を参照。
> 本ドキュメントは中期計画のサマリのみ。

## 現状 (2026-05-17)

- **Phase 1 完了**: FANZA 審査通過、カタログ同期 (2h cron) 稼働、MP4 抽出ジョブ稼働
- **Phase 2 完了**: Auth.js + マイページ (ブックマーク・履歴)、女優詳細、ホーム集約、ランキング
- **Phase 3 進行中**: ABテスト基盤、推薦ロジック改善、SEO 強化

## 次の 3 ヶ月 (Phase 3)

| 優先度 | 項目 | 状態 |
|-------|------|------|
| 🔴 | 計測イベントの可視化ダッシュボード (Metabase or Grafana) | 未着手 |
| 🔴 | 推薦アルゴリズム v1 (タグベース → 共起行列) | 未着手 |
| 🟡 | SEO: 動的サイトマップ (週次) | 未着手 |
| 🟡 | PWA 対応 (ホーム画面追加) | 未着手 |
| 🟡 | A/B テスト基盤 (Vercel Edge Config) | 未着手 |
| 🟢 | Redis キャッシュ層 (フィード / ランキング) | 検討中 |

## 6〜12 ヶ月

- AWS への移行 (Railway → ECS Fargate, Vercel → CloudFront+Lambda@Edge)
- 多言語対応 (英語圏 → アジア圏)
- 動画プレロードによる初回再生時間 200ms 短縮
- AdMax / 他 SSP との接続

## 技術的負債 (随時消化)

- `packages/shared` の自動生成スクリプト整備 (Pydantic → JSON Schema → TS)
- Pydantic v1 → v2 完全移行 (`from_attributes` 化)
- Alembic マイグレーション統合 (9 件を整理)
- 単体テストカバレッジ 60% 達成 (現状: smoke のみ)
- e2e (Playwright) シナリオ整備
