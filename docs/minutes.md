# 開発議事録

---

## 2026-05-12（火）

### 参加者
- furuikeharuki

---

### 議題1：次のロードマップ確認

**内容**
要件定義書 v3.0 と現在のコードを照合し、次のロードマップを整理した。

**ロードマップ概要**

| Phase | テーマ | 目安 | 優先度 |
|---|---|---|---|
| Phase 1 | FANZA審査通過 | 1〜2週間 | 🔴最優先 |
| Phase 2 | コンテンツ量確保（FANZA APIバッチ） | 審査通過後2週間 | 🟡 |
| Phase 3 | SEO・流入強化 | 1〜2ヶ月後 | 🟢 |
| Phase 4 | AWS移行・全自動化 | 3ヶ月後〜 | ⚪️ |

**Phase 1 具体タスク（未着手）**
- [ ] 独自ドメイン取得・Vercel設定
- [ ] TikTok風縦スクロールUI完成
- [ ] `/privacy`（プライバシーポリシー）ページ作成
- [ ] `/law`（特定商取引法）ページ作成
- [ ] モックコンテンツ10〜20件追加
- [ ] FANZA審査申請

---

### 議題2：コミットのrevert

**内容**
`fix: auto-play with IntersectionObserver and fix layout overflow` を取り消したい、という要望。

**対応**
- GitHubのAPIではforce pushができないため、revertコミットで対応。
- `apps/web/app/page.tsx` を1つ前のコミット時点の内容に復元。
- `apps/web/components/FeedItem.tsx`・`apps/web/app/globals.css` は今回追加分のため空ファイルとしてrevert。
- **残課題**：空ファイルはローカルで `git rm` して削除が必要。
  ```bash
  git rm apps/web/components/FeedItem.tsx apps/web/app/globals.css
  git commit -m "chore: remove empty files from revert"
  git push
  ```

---

### 議題3：TOP画面が動画ではなくサムネイル表示になっている原因調査・修正

**現象**
- DBの `movies` テーブルには `sample_video_url` が正しく入っている（Railway DBで確認済み）。
- `curl https://short-video-media-production.up.railway.app/api/v1/feed` の結果は全件 `"sample_video_url": null`。
- フロントは `sample_video_url` が `null` のときサムネイル表示にフォールバックするため、動画が再生されていなかった。

**原因**
`apps/api/app/services/feed_service.py` の `MovieCard` 生成処理に `sample_video_url=movie.sample_video_url` が抜けていた。

```python
# 修正前（sample_video_urlなし）
MovieCard(
    id=movie.id,
    ...
    sample_embed_url=movie.sample_embed_url,  # ← sample_video_urlが未渡し
    ...
)

# 修正後
MovieCard(
    id=movie.id,
    ...
    sample_video_url=movie.sample_video_url,  # ← 追加
    sample_embed_url=movie.sample_embed_url,
    ...
)
```

**対応**
- `feed_service.py` を修正してmainブランチへpush。
- コミット: `fix: add sample_video_url to MovieCard in feed_service`
- Railwayへのデプロイ後、`curl` で `sample_video_url` にURLが返ることを確認予定。

**補足：フィールドの役割整理**
| フィールド | 役割 | 使いどころ |
|---|---|---|
| `sample_video_url` | MP4直リンク | `<video src>` で直接再生 |
| `sample_embed_url` | 埋め込みプレイヤーURL | `<iframe src>` で表示 |
| `affiliate_url` | アフィリエイト付き商品ページ | 「購入する」ボタンの遷移先 |

---

### 残課題（次回対応）

- [ ] `git rm` で空ファイル（FeedItem.tsx・globals.css）を削除
- [ ] Railwayデプロイ完了後に `curl` で `sample_video_url` の値を再確認
- [ ] TOP画面で動画が正しく再生されることをブラウザで確認
- [ ] Phase 1タスク着手（`/privacy`・`/law` ページが最速で完了できる）
