# 要件定義書：TikTok風アダルト動画アフィリエイトメディア

**プロジェクト名**: short-video-media
**リポジトリ**: https://github.com/furuikeharuki/short-video-media
**作成日**: 2026-05-17
**最終更新**: 2026-05-19
**バージョン**: 5.8

**v5.7 → v5.8 の主な変更点**:
- **フィード動画再生の安定化全般（PR #84〜#92）** — スクロール中に一時的にサムネイル + スピナー表示される・動画が最初から再生される・サムネイル表示にスタックしてしまう・ロード中黒画面になる、等の複数の不具合を一連の PR で解消した。
  - **PR #84**: スピナー表示を 250ms 遅延して、一瞬の resolve / preload でチラつかないようにした。
  - **PR #85**: 動画ロード中はサムネイルを非表示にし、エラー時だけフォールバック表示するようにした。
  - **PR #86**: 隣接スライドも含めてプロ女優作品は 5 秒シークを適用。
  - **PR #87**: `lastPlaybackRef = {slug, time}` を追加し、ロードリトライ時も元の位置からレジュームするようにした。
  - **PR #88**: `useResolvedVideoSrc` に force リトライ 3 回 + 指数バックオフ（500ms / 1000ms / 2000ms）+ `exhausted` 以降の `enabled` 変化で再試行を追加。さらにサムネイル表示中もスピナーを出して「取得中」を明示した。
  - **PR #89**: `useResolvedVideoSrc` の `retrying` phase で `prev.src` を保持し、リトライ中も既存の MP4 URL を使い続けるようにした。
  - **PR #90**: `<video poster={thumbnailUrl}>` を追加し、ロード中の黒画面遷移を消して 「サムネイル+スピナー → 表示」 の遷移に一本化した。
  - **PR #91**: ハードタイムアウトを `VIDEO_HARD_TIMEOUT_MS = 8000 → 25000` に延長。隣接スライドの `onError` で反応しないよう `handleVideoError` を `isActive` ガード化し、`handleLoadedMetadata` / `handleCanPlay` も settle 化した。
  - **PR #92**: `useFeedPlayback` の auto-play effect 内で `video.error !== null` なら `video.load()` を呼んで MediaError を reset。隣接スライドで error になった `<video>` が中央にやってきたとき `play()` が reject される現象を解消。
- **prefetch のスクロール停止デバウンス + API で client disconnect 検知（PR #93）** — 20 枚一気にスクロールしたときに prefetch リクエストが溜まって、現在見ているスライドの resolve がキューの末尾に回るボトルネックを 3 部構成で解消した。
  - **`usePrefetchResolveMp4` に 400ms デバウンス**を追加。`currentIndex` が変わった瞬間は、対象外になった進行中 prefetch を abort するだけで、新規 prefetch は 400ms 静定してからようやく発火させる。
  - **`usePrefetchVideoBytes` も resolve 経路だけに 400ms デバウンス**を適用。`sample_movie_url` を既に持つスライドは API を叩かないので即時 slot 化し、スワイプ即応性は維持。
  - **`apps/api` `resolve_mp4` に `request.is_disconnected()` 検知**を追加。`resolver_client` 呼び出し直前でクライアントの abort を確認し、abort 済みなら `499 Client Closed Request` で即返して Playwright 抽出を起動させない。これにより resolver VPS の concurrency=2 枠を「今ユーザーが見ているスライド」のために確保できる。
- **関連デフォルト定数**: `WINDOW_SIZE = 1` / `PREFETCH_AHEAD = 3` (resolve) / `PREFETCH_AHEAD = 2` (bytes) / `PREFETCH_DEBOUNCE_MS = 400` / `RESOLVE_DEBOUNCE_MS = 400` / `VIDEO_HARD_TIMEOUT_MS = 25000` / `MAX_FORCE_RETRIES = 3` / `FORCE_RETRY_BACKOFF_MS = [500, 1000, 2000]` / `SPINNER_DELAY_MS = 250`。
- **未完了の運用タスク（要ユーザー作業、v5.7 と同じ）**: Railway DB URL ローテーション、`RESOLVER_API_KEY` ローテーション、resolver VPS の `RESOLVER_CONCURRENCY` 設定確認・調整。

**v5.6 → v5.7 の主な変更点**:
- **保存済みフィルター（GlobalFilter）基盤を確立（PR #66 〜 #71）** — `/feed` と `/search` の上にグローバルフィルターアイコンを置き、ジャンル / 女優 / シリーズ / 監督 / メーカー / レーベル / NG ワード / 期間 / 並び順 を、未認証時は `sessionStorage` (`search_prefs_v1`)、認証時は `/api/v1/me/search-prefs`（PUT / GET）に保存して URL クエリへ自動注入する仕組みを実装した。
- **新コンポーネント / フック**:
  - `components/GlobalFilterButton.tsx` — ヘッダー右上に常駐するフィルターアイコン。バッジ表示は server / session から復元した値で決定し、URL 状態（pushState 一時書き換え）に依存しない。
  - `components/AdvancedSearchPanel.tsx` — フィルター入力 UI（ボトムシート）。ジャンルチップは AdvancedSearchPanel.FieldChipRow がサジェスト一覧との case-insensitive 完全一致時のみチップ化（PR #70 で 1 文字過剰マッチを修正）。
  - `hooks/useEnforceSavedFilter.ts` — `/feed` と `/search` で URL に advanced 系の値が無いときに、保存 pref を読んで `router.replace` で URL に注入する。戻り値 `"pending" | "ready"` を Context 経由でコンテンツ側へ流す。
  - `components/SavedFilterContext.tsx` / `SavedFilterEnforcer.tsx` — ルートレイアウトに常駐し、`useEnforceSavedFilter` の status を `<SavedFilterContext.Provider>` で配下に共有。`Suspense` ラップで Next.js 15 の CSR bailout を回避。
- **PR #66**: `/search` の文脈クエリ（`q` / `genre` / `director` / `maker` / `label` / `series`）はフィルター適用後も維持するよう `useEnforceSavedFilter` の `hasAdvancedInUrl` 判定を専用化。
- **PR #67**: `/feed` 上で詳細モーダルを開いたときの再フェッチを抑止（pathname が `/feed` で始まらない間は FeedClient の useEffect が早期 return）。
- **PR #68**: フィルターが効かない 3 経路を一括修正（保存 pref が server / session どちらかにある場合の優先順位、URL 注入の dedup、`SavedFilterContext` 導入）。
- **PR #69**: `/feed?playlist=<key>`（ブックマーク / 視聴履歴 / ホーム各セクション / 女優詳細 / 検索結果カードから飛んだ経路）ではフィルターを効かせず、`GlobalFilterButton` アイコン自体も非表示にする。`useEnforceSavedFilter` 側で `isFeedPlaylist` を ready 固定 no-op に。
- **PR #70**: 残り 3 つの不具合を修正:
  - クリア後パネル再オープン時に古い pref が見える → `putSearchPref` を await にして PUT 完了前に enforcer が古い値を読まないように。
  - ジャンル「あ」一文字での過剰マッチ → `AdvancedSearchPanel.FieldChipRow` を完全一致時のみチップ化する仕様に変更。
  - 並び替えが効かない → `/api/v1/feed` に `sort` パラメータを追加し、`feed_service` / `search_repository.get_advanced_movie_ids` まで伝搬。フロントの `FeedAdvancedParams` / `getFeed` / `FeedClient` の url パース・currentSig も `sort` 対応。
- **PR #71**: 詳細モーダル / ホーム / マイページから `/feed` に戻るとフィルターが剥がれる不具合を修正:
  - 原因①: `MovieDetailModal` の `window.history.pushState("/movies/<slug>")` で Next.js 15 の `useSearchParams()` が空を返し、FeedClient の `currentSig` が空化 → useEffect 先頭で `filtersRef.current` を `{}` に上書き → モーダル open 中のスワイプで `fetchMore` がフィルター無しページを取りに行き、戻り後の feed に違反作品が混ざっていた。
  - 原因②: ホーム / マイページから BottomNav のプレーン `<Link href="/feed">` で戻ると、`SavedFilterEnforcer` が前ページ滞在中に `enforceStatus="ready"` にした値を持ち越したまま FeedClient がマウントされ、useEffect 1 回目が「ready + 空 currentSig」で走って **フィルター無しの fetch を発火** → 続く URL 注入後の 2 回目 fetch と setItems が逆転して画面に違反作品が残る現象。
  - 修正①: `FeedClient.tsx` の useEffect 先頭で `!pathname.startsWith("/feed")` ガードを `filtersRef.current` 更新の前に置く。pushState で pathname が `/movies/...` になっている間は filtersRef を一切触らない。
  - 修正②: `useEnforceSavedFilter` の戻り値を **render フェーズで派生計算** するよう変更。`lastHandledRef.current !== handleKey`（= まだ処理していない URL）かつ enforce 対象パスのときは `hasAdvancedInUrl(sp)` を同期評価し、未注入なら `"pending"`、注入済みなら `"ready"` を即返す。これで「URL 確定前は絶対に fetch しない」契約が、マウント直後の 1 回目レンダーから厳密に守られる。
- **保存済みフィルター対応の API 追加（apps/api）**:
  - `GET /api/v1/me/search-prefs` — 認証ユーザーの保存済みフィルターを返す。
  - `PUT /api/v1/me/search-prefs` — 保存済みフィルターを更新（全置換）。
  - `GET /api/v1/feed` に `sort` クエリパラメータを追加（`new` / `popular` / `rating` / `views` / `bookmarks`）。`feed_service` から `search_repository.get_advanced_movie_ids(sort=...)` まで伝搬。

**v5.5 → v5.6 の主な変更点**:
- **resolver サンプル URL パイプライン完成（PR #47, #48, #49, #50）** — DMM のサンプル動画 URL 形式（`_mhb_w.mp4`, `_dmb_w.mp4`, `_sm_w.mp4`, `_dm_w.mp4`, `mhb.mp4`, `_sm_s.mp4`, `_dmb_s.mp4`, `_dm_s.mp4` 等）について、**実検証の結果すべての形式がブラウザで再生可能**であることが確認された。以前言及されていた「`_mhb_w` / `_dm_w` は ORB エラーで再生不可」という前提は誤りであったため、形式による区分け（新形式 vs 旧形式）の概念自体を撤廃した。
- **新規ジョブ `resolve_sample_urls.py`（PR #49）** — `sample_movie_url IS NULL` の movies を resolver（`POST /resolve` Bearer 認証）で並列バックフィルするジョブ（`--concurrency 4 --limit N --dry-run` 引数）と対応 GitHub Actions workflow（cron `0 18 * * *` UTC = JST 03:00）を追加。
- **legacy URL ガードの撤廃（PR #50）** — API の `_UNPLAYABLE_SUFFIX_RE` / `_is_unplayable_legacy_url()`、jobs の `--include-legacy` / `_is_legacy()` / `LEGACY_PATTERN`、workflow の `include_legacy` input をすべて削除。全 URL 形式が再生可能と判明したため形式判定を廃止。
- **運用フロー確立** — sync_catalog → resolve_sample_urls バックフィル → 初回再生時の同期 resolve → self-heal の 4 ステップフローが確定。
- **データクリーンアップ実施（2026-05-19）** — DB 全テーブル TRUNCATE 後、4 スライス（2000-2006 / 2006-2013 / 2013-2019 / 2020-2026）で再取得。movies 186 件を resolver でバックフィル、NULL=0 達成（175 件を約 7 分で処理）。
- **テストカウント更新** — API テスト: 50 → 46 pass（legacy 4 件削除）、jobs テスト: 24 pass（変更なし）。
- **Phase 4 Stage A 完了** — resolver サービス稼働中 ＋ バックフィルパイプライン完成をもって Stage A 完了とする。

**v5.4 → v5.5 の主な変更点**:
- **`<video>` エラー時の self-healing フロー（PR #47）** — DB に残った旧 `sample_movie_url` が再生失敗を引き起こすため、再生エラーを検知したクライアント側から DB を能動的にクリーンアップする仕組みを導入。
  - **新エンドポイント `DELETE /api/v1/movies/{slug}/sample-url`** を追加（204 No Content、認証不要）。`sample_movie_url` を NULL に戻すだけのシンプルな実装で、テスト 3 件を追加し API 全体 46/46 pass。
  - **`useResolvedVideoSrc.handleError`** が `<video>` の `onError` を捕捉した時点で、fire-and-forget で `invalidateSampleUrl(slug)` を呼び DB を NULL に戻し、同時に `resolveMp4Url(slug, {force:true})` で新 URL を取得して即座に差し替える。次回以降は旧 URL を踏まない。
  - **`usePrefetchVideoBytes` の self-heal** — 戻り値を `{slots, handleSlotError}` に変更し、`PrefetchVideoBuffer` のエラーを親 hook が受け取って `healedRef: Set<string>` で slug ごと 1 回限定で `invalidateSampleUrl` + force 再解決 → slot.src を差し替えて再 preload。重複呼び出しと無限ループを抑止。
- **ORB 対策: 隠し `<video>` の配置を変更（PR #47）** — Chromium の Opaque Response Blocking が `1px × 1px / opacity:0` の `<video>` を「メディア用途と判定できない」として cross-origin MP4 を弾いていたため、`PrefetchVideoBuffer` を `position:fixed; top:-9999px; left:-9999px; width:100px; height:100px; opacity:0; pointer-events:none; z-index:-1` の画面外配置に変更。通常サイズのメディア要素として preload が走るようにした。
- **`apps/web/lib/api/resolve-mp4.ts` に `invalidateSampleUrl(slug)` を追加** — 既存の `resolveMp4Url` と同じ箇所に集約。fire-and-forget で `DELETE` を発行し、ネットワークエラーは握り潰す（UI は force resolve 側の結果に責任を持つ）。

**v5.3 → v5.4 の主な変更点**:
- **resolver 待ち中のローディング表示（PR #42）** — `useResolvedVideoSrc` に `resolving: boolean` を追加し、`phase === "resolving" | "retrying"` の間は `FeedItem` がサムネの上に既存のローディングスピナーを表示するようにした。
- **resolver 遅延後の自動再生バグ修正（PR #43）** — `useFeedPlayback` の自動再生 effect / IntersectionObserver fallback effect の依存配列に `videoSrc` が含まれていなかったため、`videoSrc=null` で mount したあとに `<video>` が后から src を受け取っても再生が起動しないケースがあった。`videoSrc: string | null` を hook の prop に追加し、両 effect の deps に含めて修正。
- **resolver MP4 URL の prefetch（PR #44）** — 新 hook `usePrefetchResolveMp4(items, currentIndex)` を追加。現在再生中のスライドより先 3 枚分の slug について、`sample_movie_url` を持たないものだけ fire-and-forget で `resolveMp4Url` を叩き、`apps/api` 側の in-flight デデュープ + 60s 成功キャッシュ（PR #40）を事前に温める。`<video>` 要素は増やさず `WINDOW_SIZE=1` を維持。
- **動画バイトの prefetch（PR #45）** — 新 hook `usePrefetchVideoBytes(items, currentIndex)` + 新コンポーネント `PrefetchVideoBuffer` を追加。`currentIndex+1 … +2` のスライドについて、画面外 (1px / opacity:0 / pointer-events:none) に `<video preload="auto" muted playsInline>` をマウントし、`useEffect` で明示的に `load()` を呼んで iOS Safari でも確実に preload を起動させる。DMM CDN は `Cache-Control: no-store` だが CloudFront エッジに `age` 最大 14 日のキャッシュがあり、事前にメディアバイトを取ると HTTP/2 接続が温まり再生開始の TTFB が縮む。業界事例（TikTok / Reels / Shorts）と同じ next 1–2 件先を採用。
- **`<video>` 同時マウント数 `WINDOW_SIZE` を 2 → 1 に変更** — モバイル Safari の同時接続上限を避けるため、`FeedViewer` はアクティブスライド 1 枚だけをレンダリングし、前後は hidden な prefetch buffer で補う構造に統一。
- **サンプル URL 推測ロジック関連ファイルの厳密な整理** — PR #39 で削除済みの `apps/web/lib/sampleUrlProbe.ts` / `apps/web/lib/api/sample-url.ts` を §3.1.3 / §3.1.4 から除去し、現状の `apps/web/components/feed/` 下に正しく反映。

**v5.2 → v5.3 の主な変更点**:
- **Phase 4 Stage A を完了** — `apps/resolver/` を Xserver VPS 2GB Tokyo（`162.43.24.128`）に本番デプロイ済み。`apps/api` の `GET /api/v1/movies/{slug}/resolve-mp4` 経由で稼働中。
- **旧サンプル URL ロジックを全削除（PR #39: `chore: remove legacy sample_movie_url guessing logic`）** — `_build_sample_mp4_url` / `buildSampleUrlCandidates` / `switchSuffix` / `parseSampleUrl` / `probeSampleUrls` / `POST /api/v1/movies/{slug}/sample-url` / `_SAMPLE_URL_RE` / `SAMPLE_URL_RATE_LIMIT_*` 設定 / `_sample_url_limiter` / 関連テスト 2 ファイル をすべて削除。合計 +12 / -278 行。`upsert_movie` は `sample_movie_url` を INSERT 時に `None`、UPDATE では一切触らない方針へ統一。今後は resolver 経由の書き戻しのみが学習元となる。
- **`apps/api` resolver_client に in-flight デデュープ + 60s 短期キャッシュを追加（PR #40: `fix(api): dedupe in-flight resolve-mp4 calls + short-term success cache`）** — `_inflight: dict[str, asyncio.Future]`（`asyncio.Lock` 保護）と `_success_cache: dict[str, (mp4_url, expires_at)]`（TTL 60 秒）を `resolver_client.py` に実装。同一 `content_id` への並列リクエストは Future を共有して resolver には 1 回しか当たらない。`force=true` 指定時も in-flight デデュープは効く（`bypass_cache=True` で短期キャッシュのみ無効化）。テスト 4 件追加、合計 43/43 pass。`+273 / -11 行`。
- **VPS resolver の同時実行を 2 → 8 に増強** — Xserver VPS 2GB Tokyo にて Playwright Chromium ブラウザを共有プール化したまま `RESOLVER_CONCURRENCY=8` まで引き上げ。8 並列でも実測 9.32 秒（1 リクエストとほぼ同等）、メモリ使用量 212 MiB / 1.465 GiB（約 14%）と大きな余裕がある。1 → 4 並列で線形スループット、4 → 8 並列でもキューイングなく安定稼働を確認済み。
- **§2 / §3.7 / §5.2 / §5.3 / §6 / §7 を実態（本番稼働中）に同期**
- **運用知見の追記**: `docker restart` では `--env-file` の値はリロードされない。環境変数を変更したときは必ず `docker stop && docker rm && docker run --env-file ...` で再生成すること（§5.4 に運用 Tips として追加）。

**v5.1 → v5.2 の主な変更点**:
- Phase 4 の「サンプル動画 MP4 URL の動的解決サービス」を **2 段階構成** に再設計（v5.1 は AWS Tokyo 単独前提だった）
  - **Stage A（暫定運用 / 短期）**: Xserver VPS 2GB Tokyo（実質月額 ¥936 / 12 ヶ月、東京 DC で日本 IP 確保）に常駐 HTTP サービスとしてデプロイ
  - **Stage B（恒久運用 / 長期）**: AWS Tokyo（Lambda Function URL もしくは Fargate Spot）へ Dockerfile ごと移植
- 新規アプリ **`apps/resolver/`** を作成方針として明文化（`apps/jobs/` への同居案は破棄、責務分離を優先）
  - 既存バッチ `apps/jobs/src/extract_mp4_urls.py` のコア関数 `extract_mp4_url` をリクエスト駆動型 API として再構成
  - 起動時に Playwright Chromium を 1 度だけ立ち上げて再利用するプール方式（同時並列はコネクション数で制御）
- §3 に **§3.7 サンプル動画 MP4 動的解決サービス（apps/resolver）** を新設
- §5.2 本番デプロイ表に Resolver / Xserver VPS Tokyo の行を追加
- §5.3 環境変数に `apps/resolver` 用・`apps/api` 側呼び出し用の変数を追加
- §7 リスク表に「VPS 単一障害点 / Xserver から AWS への移行コスト」項目を追加

**v5.0 → v5.1 の主な変更点**:
- 実装とのズレを一斉に同期（2026-05-18 検証）
- Alembic マイグレーション 9 件 → 11 件に更新（複合 index 追加・`goods` / `actress_goods` テーブル追加）
- `goods` / `actress_goods` テーブルと `apps/api/app/db/models/goods.py` を §4 に追加
- `sync_actress_profiles.py` ジョブを §3.4 と §3.5 （`sync-catalog-full.yml` 連続実行）に反映
- CI ワークフロー（`api-ci.yml` / `jobs-ci.yml` / `web-ci.yml`）と `debug-dmm-api.yml` が実装済みであることを反映
- ホームのセクション一覧ページ `/list/[key]` と `GET /api/v1/home/section` を追記
- `/api/v1/me/*` のエンドポイント表を実装に合わせて修正（POST/DELETE bookmarks、bookmarks/ids、POST/GET views）
- `genres.py` / `performers.py` は「空ファイル」ではなく「コードベースに存在しない（廃止方針）」と訂正
- `apps/jobs/src/` の `backfill_slugs` / `generate_related` / `rebuild_cache` / `recompute_rankings` は「空ファイル」ではなく「未作成」と訂正
- `docs/` の補助ドキュメント群が「空ファイル」ではなく「簡易実装済み」であることを反映
- §6 Phase 4 に「サンプル動画 MP4 URL の動的解決サービス (BFF + ハイブリッド方式)」を新規 TODO として追加
- §7 リスク表の 「MP4 URL の署名失効」項を、実測結果（トークン 32 日以上有効、CORS 全開放）に基づいて訂正

**v4.0からの主な変更点**:
- **FANZA審査が通過済み**であることを反映（Phase 1 完了）
- `apps/jobs/src/sync_catalog.py` が **42KB の本実装** となり、DMM ItemList API の全件取得・期間スライス・フロア別擬似ジャンル付与・goods フィルタ等まで完成していることを反映
- **新規ジョブ `extract_mp4_urls.py` (15.7KB)** を追加。Playwright (Chromium) で DMM litevideo iframe から MP4 直リンクを抽出する仕組みを記載
- 切り分け用デバッグスクリプト **`debug_extract.py`** を追加
- **GitHub Actions による定期実行を整備済み**：
  - `sync-catalog.yml`（2 時間ごとに増分取得、cron `0 */2 * * *`）
  - `sync-catalog-full.yml`（毎月 1 日 10:00 JST に全件＋ sample URL リフレッシュ）
  - `migrate.yml`（main への push 時に alembic upgrade head）
- **認証基盤を新設**：Auth.js v5 (Twitter / Discord OAuth) ＋ FastAPI 側 `/auth/sign-in` の exchange JWT 方式。provider 個人情報は一切 DB に保存せず、`Identity.sub_hash = SHA-256(provider:sub:APP_USER_SALT)` のみ保持
- **マイページ機能**：ブックマーク・視聴履歴（`/me/*` エンドポイント、`Bookmark` / `ViewHistory` テーブル）
- **女優詳細ページ**：`/api/v1/actresses/{name}` ＋ DMM 女優検索 API 由来のプロフィール 13 列を `actresses` テーブルに追加
- **ホーム画面集約 API**：`/api/v1/home`（本日配信開始・新着・人気・週/月/日ランキング・検索数の高いジャンル 3 セクション）
- **ランキング API**：`/api/v1/rankings?period=daily|weekly|monthly`
- **イベント計測 API 実装済み**：`POST /api/v1/events`（view / play / detail_click / affiliate_click / search）。`search_query` カラム＋インデックスを追加
- **作品詳細モーダル**：Next.js パラレルルート `@modal/(.)movies/[slug]` で TikTok 風遷移を実装
- **検索フィード**：`/search/feed` で検索結果も縦スクロール再生できるように
- **法務ページ実装完了**：`/privacy`・`/law`・`/contact` の本文と運営者情報を整備済み
- 性能改善：並列プローブによる初回再生高速化、サンプル動画 URL の学習キャッシュ、ランキング集計修正、未発売作品の取扱見直しなど多数
- `apps/api/Dockerfile`・`apps/jobs/Dockerfile`（Playwright + Chromium 同梱）整備済み
- マイグレーションは 9 件まで進行（最新: `8a3c1f2e9d04 add actress profile columns`）

---

## 1. プロジェクト概要

### 1.1 目的

FANZA アフィリエイトを収益源とした、TikTok 風縦スクロール UI のアダルト動画メディアサイトを構築する。単なるサイト制作ではなく、**データ取得から公開・運用までを自動化された基盤**として運用することが中期目標である。

最終的には AWS 上で全サービスを運用することを前提とし、各アプリはコンテナで動作する設計とする。

### 1.2 コアバリュー

- スマートフォンに最適化された TikTok 風 UX による高い滞在時間と CVR
- FANZA / DMM API を通じた大量コンテンツの自動取得・自動掲載
- 全アプリのコンテナ化によるクラウド非依存の移植性
- ローカル開発〜本番環境を Docker で統一し、CI/CD と接続しやすい構成

### 1.3 収益モデル

| 収益源 | 概要 |
|--------|------|
| FANZA アフィリエイト | 作品購入・動画視聴への誘導による成果報酬 |
| SSP 広告（AdMax 等） | アクセス増加後の補助収益として追加 |

---

## 2. 現状（2026 年 5 月 19 日時点）

### 2.1 完了したマイルストーン

| 項目 | 状態 |
|------|------|
| **FANZA 審査通過** | ✅ 完了 |
| 独自ドメインでの本番公開 | ✅ 完了（Vercel） |
| `/privacy`・`/law`・`/contact` の本文実装 | ✅ 完了 |
| FANZA API 連携バッチ（`sync_catalog.py`） | ✅ 本実装済み（42KB） |
| MP4 直リンク抽出ジョブ（`extract_mp4_urls.py`） | ✅ 実装済み（15.7KB） |
| Alembic マイグレーション | ✅ 11 件適用済み |
| 定期実行（GitHub Actions cron） | ✅ 増分 2h / 全件 月 1 / sample URL バックフィル 毎日 03:00 JST を稼働中 |
| 認証 (Twitter / Discord OAuth) | ✅ 実装済み |
| マイページ（ブックマーク / 視聴履歴） | ✅ 実装済み |
| 作品詳細ページ＋モーダル | ✅ 実装済み |
| 検索ページ（一覧 / 縦フィード） | ✅ 実装済み |
| 女優詳細ページ | ✅ 実装済み |
| ホーム画面集約 API | ✅ 実装済み |
| イベント計測 API（view / play / detail_click / affiliate_click / search） | ✅ 実装済み |
| ランキング API（日 / 週 / 月） | ✅ 実装済み |
| **resolver バックフィルパイプライン（`resolve_sample_urls.py` + workflow）** | ✅ 完了（PR #49） |
| **legacy URL ガード撤廃（全 URL 形式が再生可能と確認）** | ✅ 完了（PR #50） |
| **保存済みフィルター（GlobalFilter / SavedFilterEnforcer / `/me/search-prefs`）** | ✅ 実装済み（PR #66〜#71） |
| **`/api/v1/feed` の sort パラメータ（並び順連携）** | ✅ 実装済み（PR #70） |

### 2.2 デプロイ構成（現状）

| アプリ | デプロイ先 | 状態 |
|--------|-----------|------|
| `apps/web`（Next.js 15.3 + React 18） | Vercel | 稼働中 |
| `apps/api`（FastAPI） | Railway | 稼働中（lifespan で `alembic upgrade head` 自動実行） |
| `apps/jobs`（Python + Playwright） | GitHub Actions（cron）／ Railway（手動・任意） | 稼働中 |
| `apps/resolver`（FastAPI + Playwright Chromium） | **Xserver VPS 2GB Tokyo（`162.43.24.128`）** | **稼働中**（`RESOLVER_CONCURRENCY=8`、メモリ上限 1500m + swap 2g、`shortvideo/resolver:latest`） |
| DB | Railway Postgres（将来 AWS RDS へ移行予定） | 稼働中 |

### 2.3 未実装・継続課題

| 対象 | 状態 | 優先度 |
|------|------|--------|
| `packages/shared/*` の JSON Schema / TS 型 | DB スキーマと未同期。`movies` テーブルの新列（actress プロフィール等）が反映されていない | 🟡 中 |
| `apps/web/Dockerfile` | 未作成（Vercel で完結しているため後回し） | 🟢 低 |
| Redis キャッシュ | 未導入（Phase 3 以降） | 🟢 低 |
| `apps/jobs/src/generate_related.py` | 未実装（関連作品レコメンド。スクリプトファイル自体が無い） | 🟢 低 |
| `apps/jobs/src/rebuild_cache.py` | 未実装（Redis 導入時に使用予定） | 🟢 低 |
| `apps/jobs/src/recompute_rankings.py` | 未実装（現在は API リクエスト時に算出。バッチ化は将来検討） | 🟢 低 |
| `apps/jobs/src/backfill_slugs.py` | 未実装（旧データの slug 再生成。スクリプトファイル自体が無い） | 🟢 低 |
| `.github/workflows/api-ci.yml` | ✅ 実装済み（apps/api への push / PR で pytest を実行） | – |
| `.github/workflows/jobs-ci.yml` / `web-ci.yml` | ✅ 実装済み（CI 整備済み） | – |
| `docs/architecture.md`・`db-schema.md`・`api-contract.md`・`environments.md`・`roadmap.md` | 簡易実装済み（30〜85 行程度。継続加筆中） | 🟡 中 |
| `apps/resolver/` （サンプル動画 MP4 動的解決サービス） | ✅ 本番稼働中（Xserver VPS 2GB Tokyo `162.43.24.128`、`RESOLVER_CONCURRENCY=8`） | – |
| Xserver VPS 2GB Tokyo の契約 | ✅ 契約済み・稼働中。実質月額 ¥936 / 月均（12 ヶ月一括キャッシュバック適用後） | – |
| API キーのローテーション | ⚠️ セッション中に `RESOLVER_API_KEY` の値がチャットに 1 度貼られた可能性あり。新規 `openssl rand -hex 32` を発行し VPS `.env` と Railway 環境変数の双方で差し替え推奨（ブロッキングではない） | 🟡 中 |
| AWS 移行（ECR / ECS / RDS / EventBridge） | 未着手（Phase 4 Stage B） | ⚪️ 後 |
| モニタリング（UptimeRobot 等での `/health` 監視） | 未着手 | 🟡 中 |

### 2.4 直近のオープン作業

- 現時点で main へのオープン PR なし（PR #47〜#50 と #66〜#71 はマージ済み、main HEAD = `041f230`）。
- 2026-05-19 に DB 全テーブルを TRUNCATE し、4 スライス（2000-2006 / 2006-2013 / 2013-2019 / 2020-2026）× `hits=100 floors=videoa` で再取得を実施。movies 186 件（年代別: 2006=8 / 2013=52 / 2019=71 / 2026=55）を resolver でバックフィルし、NULL=0 達成（175 件を約 7 分で処理、並列 4）。
- URL 形式分布（実測）: `_mhb_w.mp4` (68) / `mhb.mp4` (56) / `_dmb_w.mp4` (36) / `_sm_w.mp4` (12) / `_sm_s.mp4` (5) / `_dmb_s.mp4` (3) / `_dm_s.mp4` (3) / `_dm_w.mp4` (3) — **全て再生可能**。
- 次の主な観測対象: バックフィルジョブ（毎日 03:00 JST）の安定稼働、resolver の `_inflight` / `_success_cache` がメモリリークしないこと、`RESOLVER_CONCURRENCY=8` でも DMM 側にレート制限を受けないこと、保存済みフィルターが詳細モーダル / ホーム / マイページからの戻りで剥がれずに維持されること（PR #71）。

---

## 3. 機能要件

### 3.1 フロントエンド（apps/web）

スタック: Next.js 15.3（App Router）＋ React 18 ＋ TypeScript 5.8 ＋ Auth.js v5 ＋ `jose`。

#### 3.1.1 実装済みページ

| パス | 役割 |
|------|------|
| `/` | ホーム画面。`api/v1/home` のセクションを上から並べた縦カードロウ表示（`HorizontalCardRow.tsx` 利用） |
| `/feed` | TikTok 風縦スクロールフィード（メイン体験） |
| `/movies/[slug]` | 作品詳細ページ |
| `@modal/(.)movies/[slug]` | パラレルルートによる作品詳細モーダル（フィードからの遷移時に使用） |
| `/search` | 検索（グリッド表示） |
| `/search/feed` | 検索結果の縦スクロール再生 |
| `/list/[key]` | ホーム画面の各セクション（`popular` / `new` / `recent` / `ranking_daily|weekly|monthly`）から遷移する一覧ページ |
| `/actresses/[name]` | 女優詳細（プロフィール＋出演作品＋関連グッズ） |
| `/age-gate` | 年齢確認ページ（middleware で全ページから強制リダイレクト） |
| `/auth/error` | 認証エラー表示 |
| `/mypage` | マイページ（ブックマーク・視聴履歴） |
| `/privacy` | プライバシーポリシー（FANZA 審査済） |
| `/law` | 特定商取引法に基づく表記（FANZA 審査済） |
| `/contact` | お問い合わせ（`avshorts0512@gmail.com`） |
| `/robots.ts`・`/sitemap.ts` | SEO 用ファイル |

#### 3.1.2 主要コンポーネント

- **保存済みフィルター（GlobalFilter）**:
  - `components/GlobalFilterButton.tsx`: ヘッダー右上に常駐するフィルターアイコン。クリックで `AdvancedSearchPanel` をボトムシートとして開く。バッジ表示は保存済み pref（server / session）から復元した値で決定し、URL 状態（詳細モーダル open で pushState 一時書き換えされるパターン）に依存しない。`/feed?playlist=<key>` 経路（ブックマーク / 視聴履歴 / ホームセクション / 女優詳細 / 検索カード）ではアイコン自体を非表示。
  - `components/AdvancedSearchPanel.tsx`: フィルター入力 UI。ジャンル / 女優 / シリーズ / 監督 / メーカー / レーベル / NG ワード / 期間 / 並び順を保存する。`AdvancedSearchPanel.FieldChipRow` はサジェスト一覧との case-insensitive 完全一致時のみチップ化する（PR #70 で1 文字過剰マッチを修正）。
  - `hooks/useEnforceSavedFilter.ts`: `/feed` と `/search` で URL に advanced 系の値が乗っていないとき、保存 pref（認証時は `/api/v1/me/search-prefs`、未認証は `sessionStorage`）を読んで `router.replace` で URL に注入する。`/feed?playlist=...` では ready 固定 no-op。戻り値 `"pending" | "ready"` は Context 経由でコンテンツ側へ流し、コンテンツ側は pending 中は fetch を走らせずスピナーを出して違反作品フラッシュを防ぐ。戻り値は **render フェーズで派生計算** されるため（PR #71）、ホーム / マイページからプレーン `<Link href="/feed">` で戻ってきたときも、マウント直後 1 回目のレンダーから正しい `"pending"` を Context に流せる。
  - `components/SavedFilterEnforcer.tsx` / `components/SavedFilterContext.tsx`: ルートレイアウトに常駐し、`useEnforceSavedFilter()` の status を `<SavedFilterContext.Provider>` で配下に共有。`Suspense` ラップで Next.js 15 の `useSearchParams()` による CSR bailout を回避。
  - `lib/api/me.ts` に `getSearchPref()` / `putSearchPref()` を追加し、認証ユーザーの pref を server で取り回す。`putSearchPref` は await 必須（PR #70）で、PUT 完了前に enforcer が古い値を読まないようにしている。
- **フィード**:
  - `app/FeedClient.tsx`: 仮想スクロール（`translateY` 方式、`scroll-snap` は使わない）。`useSavedFilterStatus()` で Context を購読し、`enforceStatus === "pending"` の間はスピナー表示し fetch を一切走らせない。useEffect 先頭で `!pathname.startsWith("/feed")` ガードを `filtersRef.current` 更新の前に置き（PR #71）、詳細モーダル open 中の pushState で pathname が `/movies/...` になっている間は filtersRef を一切触らない。`currentSig` は genres / actresses / series_list / directors / makers / labels / ng_words / date_from / date_to / **sort** を含めて計算される。
  - `components/FeedViewer.tsx`: フィードのコアビューワ。`WINDOW_SIZE = 1` （モバイル Safari の同時接続上限回避のためアクティブ 1 枚のみレンダリング）。裏で `usePrefetchResolveMp4`（先 3 枚分の MP4 URL 解決）と `usePrefetchVideoBytes`（先 2 枚分の動画バイト）を呼び、prefetch 用の隠し `<video>` を `PrefetchVideoBuffer` としてマウント。
  - `components/FeedItem.tsx`: フィード 1 件分のコンテナ。`useResolvedVideoSrc` + `useFeedPlayback` を使用し、resolver 待ちのローディングオーバーレイを表示する。`VIDEO_HARD_TIMEOUT_MS = 25000`（PR #91）を保持し、`handleVideoError` は `isActive` スライドのみで反応する（隣接スライドの error を拾わない）。同じく `handleLoadedMetadata` / `handleCanPlay` も settle 化してあり、一度 settle したら hard timeout をクリアする。スピナー表示は `SPINNER_DELAY_MS = 250`（PR #84）でチラつき防止。
  - `components/feed/FeedItemMeta.tsx`・`FeedItemSideActions.tsx`・`FeedItemVideo.tsx`・`feedItemStyle.ts`: 責務別のフィードパーツ。`FeedItemVideo.tsx` は `<video poster={thumbnailUrl}>`（PR #90）でロード中の黒画面遷移を消し、サムネイル表示はエラー時だけ（PR #85）に限定される。
  - `components/feed/useResolvedVideoSrc.ts`: MP4 URL 解決 hook。`initial / resolving / ready / retrying / exhausted` のフェーズを持ち、`resolving` フラグを返す。`MAX_FORCE_RETRIES = 3` / `FORCE_RETRY_BACKOFF_MS = [500, 1000, 2000]`（PR #88）で force リトライし、`retrying` phase でも `prev.src` を保持する（PR #89）ので、リトライ中も既存 URL で再生を継続できる。`exhausted` でも `enabled` が false→true に変わると再試行する。`handleError` で `<video>` エラーを捕捉した際に `invalidateSampleUrl(slug)`（fire-and-forget）と force 再解決を同時に走らせる self-heal 接点も所有。
  - `components/feed/useFeedPlayback.ts`: 自動再生 / mute / ジェスチャー判定を担う hook。`videoSrc` prop を deps に含めて、resolver 遅延後の mount でも確実に自動再生させる。auto-play effect 内で `video.error !== null` なら `video.load()` を呼んで MediaError を reset（PR #92）し、隣接で error になった `<video>` が中央にやってきたときも `play()` が reject されないようにする。さらに `lastPlaybackRef = {slug, time}`（PR #87）でロードリトライ時は元の位置からレジュームする。
  - `components/feed/usePrefetchResolveMp4.ts`: 先 3 枚分の MP4 URL を事前解決して API キャッシュを温める hook。`PREFETCH_AHEAD = 3` / `PREFETCH_DEBOUNCE_MS = 400`（PR #93）。`currentIndex` が変わった瞬間は、対象外になった進行中 prefetch を abort するだけで、新規 prefetch は 400ms 静定してからようやく発火する。一気スクロールしても resolver VPS にリクエストが溜まらないようにするための仕掛け。
  - `components/feed/usePrefetchVideoBytes.ts`: 先 2 枚分の動画バイトを裏で取るための slot 管理 hook。`PREFETCH_AHEAD = 2` / `RESOLVE_DEBOUNCE_MS = 400`（PR #93）。`sample_movie_url` を既に持つスライドは即時 slot 化してスワイプ即応性を維持し、resolve 経路（= API を叩くスライド）だけデバウンスを適用する。戻り値は `{slots, handleSlotError}` で、`PrefetchVideoBuffer` からエラーを受け取ると `healedRef: Set<string>` で slug ごと 1 回限定で `invalidateSampleUrl` + force 再解決を走らせ、成功時は slot.src を差し替えて再 preload。
  - `components/feed/PrefetchVideoBuffer.tsx`: 画面外（`position:fixed; top:-9999px; left:-9999px; 100px×100px; opacity:0; pointer-events:none; z-index:-1`）に `<video preload="auto" muted playsInline>` を配置し、メディアバイトをバックグラウンドで先読みさせる。`onError` で親に 1 回だけ失敗を通知（`notifiedRef`）して self-heal チェーンをトリガー。画面外 + 通常サイズにしたのは、Chromium の Opaque Response Blocking が `1px / opacity:0` だと cross-origin MP4 を「メディア用途と判定できず」弾いてしまうため。
- **ナビゲーション**: `Header.tsx`（固定ヘッダー、`--header-h: 52px`）、`HamburgerMenu.tsx`、`BottomNav.tsx`、`BackButton.tsx`
- **作品詳細**: `components/movie-detail/MovieDetailContent.tsx`・`MovieDetailModal.tsx`
- **ホーム**: `components/home/HorizontalCardRow.tsx`・`MovieCardThumb.tsx`・`PullToRefresh.tsx`
- **認証**:
  - `auth.ts`（Auth.js v5 設定。Twitter / Discord providers）
  - `components/SessionProvider.tsx`
  - `components/auth/BookmarksProvider.tsx`（クライアント側ブックマーク状態の共有）
- **計測**: `components/analytics/affiliate-link.tsx`・`detail-view-tracker.tsx`・`age-gate-form.tsx`

#### 3.1.3 API クライアント層（`apps/web/lib/api/`）

| ファイル | 役割 |
|----------|------|
| `feed.ts` | `getFeed(cursor, limit, seed)` |
| `home.ts` | ホームセクション取得 |
| `movies.ts` | 作品詳細取得 |
| `search.ts` | 検索 |
| `tags.ts` | ジャンル一覧 |
| `actresses.ts` | 女優詳細 |
| `events.ts` | イベント送信（POST `/api/v1/events`） |
| `me.ts` | マイページ（ブックマーク / 視聴履歴の取得・更新）、`getSearchPref()` / `putSearchPref()`（保存済みフィルター）も含む |
| `resolve-mp4.ts` | `GET /api/v1/movies/{slug}/resolve-mp4` を叩いて再生可能な MP4 URL を取得。`force` / `signal` オプション対応。失敗時は null を返しサムネにフォールバック。同じファイルに `invalidateSampleUrl(slug)` （`DELETE /api/v1/movies/{slug}/sample-url` を fire-and-forget で叩く）も集約。再生エラー時の self-heal フローで使用。 |

#### 3.1.4 補助ロジック（`apps/web/lib/`）

- `feedOrder.ts`: seed 生成・既読管理
- `feedNav.ts` / `feedPlaylist.ts`: フィード内ナビゲーション
- `config/env.ts`: 環境変数アクセス
- `analytics/analytics.ts`: イベント送信ヘルパ

※ PR #39 で `apps/web/lib/sampleUrlProbe.ts` / `apps/web/lib/api/sample-url.ts` は削除済み。クライアント側での MP4 URL 推測ロジックは全廃し、サーバー側の resolver 経由に一本化した。

#### 3.1.5 API ルートハンドラ（`apps/web/app/api/`）

- `api/age-gate/route.ts`: 年齢確認 cookie 設定
- `api/auth/[...nextauth]/route.ts`: Auth.js のエンドポイント
- `api/events/route.ts`: フロントから FastAPI への計測イベント中継
- `api/proxy/me/[...path]/route.ts`: マイページ系 API のサーバーサイド転送（JWT を Authorization ヘッダに付与する）

#### 3.1.6 年齢確認フロー

- `middleware.ts` で全ページのアクセスを遮断
- `/age-gate` で同意 → cookie 記録 → `location.href` でフルナビゲーション

### 3.2 バックエンド API（apps/api）

スタック: FastAPI ＋ SQLAlchemy 2.x（async）＋ asyncpg ＋ Alembic ＋ Pydantic v2 ＋ PyJWT。

#### 3.2.1 実装済みエンドポイント

| メソッド | パス | 役割 |
|----------|------|------|
| GET | `/api/v1/health` | 死活監視 |
| GET | `/api/v1/feed` | フィード一覧（`offset`・`limit`・`seed`・`genres[]`・`actresses[]`・`series_list[]`・`directors[]`・`makers[]`・`labels[]`・`ng_words[]`・`date_from`・`date_to`・`sort`）。`sort` は `new` / `popular` / `rating` / `views` / `bookmarks`（PR #70 で追加）。 |
| GET | `/api/v1/movies/{slug}` | 作品詳細 |
| POST | `/api/v1/movies/{slug}/sample-url` | クライアントが見つけた有効 MP4 URL を保存（URL 検証あり） |
| DELETE | `/api/v1/movies/{slug}/sample-url` | `sample_movie_url` を NULL に戻す（self-heal フロー用、認証不要、204 No Content） |
| GET | `/api/v1/movies/{slug}/resolve-mp4` | resolver 経由で MP4 URL を動的解決して返す（DB キャッシュ → in-flight デデュープ → resolver の順で解決）。resolver 呼ぶ直前に `request.is_disconnected()` でクライアントの abort を確認し、abort 済みなら `499 Client Closed Request` で即返し Playwright 抽出を起動しない（PR #93）。 |
| GET | `/api/v1/search` | キーワード検索（`q` 部分一致 ／ `director`・`maker`・`label` 完全一致） |
| GET | `/api/v1/tags/popular` | ジャンルランキング（`movie_genres` 集計） |
| POST | `/api/v1/events` | view / play / detail_click / affiliate_click / search を記録 |
| GET | `/api/v1/rankings?period=daily\|weekly\|monthly` | ランキング |
| GET | `/api/v1/home` | ホーム画面用集約レスポンス |
| GET | `/api/v1/home/section` | ホームの個別セクション一覧（`/list/[key]` の裏側、ページング対応） |
| POST | `/api/v1/auth/sign-in` | Next.js exchange JWT → 内部 User JWT 交換 |
| GET | `/api/v1/me/bookmarks` | ブックマーク一覧 |
| GET | `/api/v1/me/bookmarks/ids` | ブックマーク movie_id 一覧（state 復元用） |
| POST | `/api/v1/me/bookmarks` | ブックマーク追加 |
| DELETE | `/api/v1/me/bookmarks` | ブックマーク解除 |
| POST | `/api/v1/me/views` | 視聴履歴の記録（204 No Content） |
| GET | `/api/v1/me/views` | 視聴履歴一覧 |
| GET | `/api/v1/actresses/{name}` | 女優詳細（DMM 女優 API 由来プロフィール＋出演作品＋関連グッズ。`movie_limit` / `goods_limit` クエリで件数調整） |
| GET | `/api/v1/me/search-prefs` | 認証ユーザーの保存済みフィルターを返す（PR #66） |
| PUT | `/api/v1/me/search-prefs` | 保存済みフィルターを更新（全置換、PR #66） |

#### 3.2.2 過去想定して廃止したエンドポイント

`genres.py` / `performers.py` は当初の設計では用意していたが、現状コードベースには存在しない（`api.py` にも未 include）。ジャンル一覧は `/api/v1/tags/popular` に集約し、女優一覧は `/api/v1/actresses/{name}` に集約しているため将来も新設不要の方針。

#### 3.2.3 設計上の重要原則

- DB フィールド・ORM モデル・Pydantic スキーマ・サービス層・レスポンスの 5 層は**必ず同時にレビュー・更新する**
- `content_id`（FANZA 商品 ID）・`product_id`（品番）・`maker_product`（メーカー品番）の 3 種 ID を必ず DB に保持する
- DB の `created_at` 系は `TIMESTAMP WITHOUT TIME ZONE`（naive UTC）。tz-aware を渡すと asyncpg が `DataError` を投げるため、必ず `datetime.now(timezone.utc).replace(tzinfo=None)` を渡す
- フィールド名変更は過去に多数の bug を生んだので、命名前に DMM API 実レスポンスと照合する
- DMM Affiliate API が返す `al.fanza.co.jp` 形式のリンクは新規アカウントで「無効リンク」になるため、`af_id` を直接付けた本家 `dmm.co.jp` URL を `sync_catalog` 側で組み立てる

### 3.3 認証基盤（apps/web ＋ apps/api 横断）

#### 3.3.1 構成

```
[ユーザー]
   ↓ OAuth (Twitter / Discord)
[Auth.js v5 on Vercel]
   ↓ exchange JWT (purpose=signin, aud=short-video-media-signin, exp=60s)
[FastAPI /api/v1/auth/sign-in]
   ↓ Identity.sub_hash = SHA-256(provider:sub:APP_USER_SALT) で get_or_create
[内部 User]
   ↓ 内部 User JWT (sub=user.id, aud=settings.JWT_AUDIENCE, exp=30d) を発行
[Next.js セッションに格納 → 以後 /api/proxy/me/* で Authorization: Bearer ... を付与]
```

#### 3.3.2 個人情報非保存ポリシー

- provider 側のメール・名前・アバター・アクセストークンを **一切 DB に保存しない**
- `Identity` テーブルが保持するのは `provider` と `sub_hash`（64 文字 hex）のみ
- 同一 User に複数 Identity（Twitter ＋ Discord 等）を紐付け可能

#### 3.3.3 必要環境変数

| 変数 | 用途 |
|------|------|
| `AUTH_SECRET` | Auth.js 署名鍵。FastAPI 側で exchange JWT 検証にも使用 |
| `AUTH_TWITTER_ID` / `AUTH_TWITTER_SECRET` | Twitter OAuth |
| `AUTH_DISCORD_ID` / `AUTH_DISCORD_SECRET` | Discord OAuth |
| `JWT_SECRET` / `JWT_AUDIENCE` | 内部 User JWT |
| `APP_USER_SALT` | `sub_hash` の SALT。漏洩したら全 Identity を再構築する必要があるため絶対に変更しない |

### 3.4 データ取得バッチ（apps/jobs）

#### 3.4.1 スクリプト一覧

| ファイル | 状態 | 役割 |
|----------|------|------|
| `src/sync_catalog.py` | ✅ 実装済み（42KB） | DMM ItemList API から取得・正規化・upsert。`--gte-date` / `--lte-date` 引数で年代別取得も可能（PR #49 で追加） |
| `src/sync_actress_profiles.py` | ✅ 実装済み | DMM ActressSearch API で DB 内女優のプロフィール 13 列を更新（月 1 / `--only-missing` モードで差分実行可） |
| `src/extract_mp4_urls.py` | ✅ 実装済み（15.7KB） | Playwright で MP4 直リンク抽出 |
| `src/resolve_sample_urls.py` | ✅ 実装済み（PR #49） | `sample_movie_url IS NULL` の movies を resolver（`POST /resolve` Bearer 認証）で並列バックフィル。`--concurrency 4 --limit N --dry-run` 引数対応 |
| `src/debug_extract.py` | ✅ 実装済み（6.0KB） | 抽出失敗の切り分け用 |
| `src/generate_related.py` | 未実装 | 関連作品レコメンド（スクリプトファイル自体が未作成） |
| `src/rebuild_cache.py` | 未実装 | Redis キャッシュ再構築（Phase 3 用） |
| `src/recompute_rankings.py` | 未実装 | ランキングのバッチ事前計算（現状は API 側で都度算出） |
| `src/backfill_slugs.py` | 未実装 | 旧データの slug 再生成（過去の DB マイグレ用途。当面不要） |

#### 3.4.2 `sync_catalog.py` の仕様

- 対象フロア:
  - `FANZA / digital / videoa`（単体女優物）
  - `FANZA / digital / videoc`（アマチュア）
  - `FANZA / mono / goods`（女優グッズ。cron では取得せず、月 1 の全件取得時のみ）
- 並び順 `sort=date`（配信開始日 desc）、1 リクエスト最大 100 件、rate limit 1 req/sec
- 既存 `content_id` があれば UPDATE、無ければ INSERT
- ジャンル / 女優 / シリーズ / メーカー / レーベル / 監督も同時に upsert
- フロア別の擬似ジャンル（`videoc → アマチュア`、`videoa → プロ女優`）を同期時に自動付与
- `--mode full` で期間スライス（gte_date / lte_date 月単位）を回し offset 50000 上限を回避。`--gte-date` / `--lte-date` 引数（PR #49 追加）で年代別の手動取得も可能
- `--refresh-sample-url` で `sample_movie_url` の強制上書き（月 1 のフルジョブで自動有効化）
- 環境変数: `DMM_API_ID`・`DMM_AFFILIATE_ID`（末尾 -990〜-999）・`DMM_LINK_AFFILIATE_ID`（末尾 -001 等。未設定なら `DMM_AFFILIATE_ID` をフォールバック）・`DATABASE_URL`
- `goods` フロアは、DB に既に存在する女優に紐付くもののみ保存

#### 3.4.3 `extract_mp4_urls.py` の仕様

- DMM litevideo iframe ページ（HTML プレイヤー）を Playwright (Chromium) で開き、JS が動的に生成する `<video src>`（`https://cc3001.dmm.co.jp/pv/<token>/<cid>mhb.mp4`）を取得して DB に保存
- 一般 CDN パス `cc3001.dmm.co.jp/litevideo/freepv/...` は古い作品にしか使われないため、新作・未発売作品はヘッドレスブラウザでの抽出が必須
- 実行要件:
  - Playwright (Chromium) インストール済み
  - **日本 IP からアクセスできること**（海外 IP には DMM が `not-available-in-your-region` リダイレクトを返す）
  - DB へのアクセス（`DATABASE_URL`）
- 使い方:
  - `python -m src.extract_mp4_urls --cid 1sun00052a --dry-run`（単体テスト）
  - `python -m src.extract_mp4_urls --only-broken`（4xx になっているものだけ更新）
  - `python -m src.extract_mp4_urls --all --concurrency 4`（全件、並列 4）

#### 3.4.4 `resolve_sample_urls.py` の仕様（PR #49）

- `sample_movie_url IS NULL` の `movies` レコードをすべて取得し、resolver（`POST /resolve` Bearer 認証）に並列投げして `sample_movie_url` をバックフィルする
- resolver host: `162.43.24.128`（`RESOLVER_BASE_URL` 環境変数）
- 引数:
  - `--concurrency 4`（デフォルト 4、resolver 側の `RESOLVER_CONCURRENCY=8` の半分以内推奨）
  - `--limit N`（処理件数上限、省略時は全 NULL 件を処理）
  - `--dry-run`（DB 書き込みをスキップして件数・対象のみ確認）
- 必要環境変数: `DATABASE_URL`・`RESOLVER_BASE_URL`・`RESOLVER_API_KEY`

#### 3.4.5 `debug_extract.py`

MP4 抽出に失敗した CID について、リクエスト・レスポンス・iframe HTML・JS console をすべて吐き出し、`not-available-in-your-region` リダイレクトや GeoIP ブロック・SPA レンダリング不全などを切り分ける。

### 3.5 GitHub Actions（定期実行）

| ワークフロー | トリガー | 役割 |
|-------------|---------|------|
| `sync-catalog.yml` | cron `0 */2 * * *`（2 時間ごと） / 手動（`gte_date` / `lte_date` inputs 対応） | DMM ItemList から増分取得（videoa, videoc。各 100 件） |
| `sync-catalog-full.yml` | cron `0 1 1 * *`（毎月 1 日 10:00 JST） / 手動 | 全期間フル取得＋ `sample_movie_url` 強制リフレッシュ＋ `sync_actress_profiles` 連続実行。最大 350 分タイムアウト |
| `resolve-sample-urls.yml` | cron `0 18 * * *`（UTC、= JST 03:00）/ 手動 | `sample_movie_url IS NULL` の movies を resolver でバックフィル。必要 Secrets: `DATABASE_URL`・`RESOLVER_BASE_URL`・`RESOLVER_API_KEY` |
| `migrate.yml` | main への push（`apps/api/alembic/**`・`apps/api/app/db/**`・`alembic.ini`・`pyproject.toml`・自身）／ 手動 | 本番 DB に `alembic upgrade head` を実行 |
| `debug-dmm-api.yml` | `workflow_dispatch` 手動 | 特定 content_id について DMM API の生レスポンスをダンプ（取得漏れフィールド調査用） |
| `api-ci.yml` | apps/api への push / PR | pytest（DB 接続不要のテストのみ） |
| `jobs-ci.yml` | apps/jobs への push / PR | jobs 側の lint / test |
| `web-ci.yml` | apps/web への push / PR | web 側の lint / test |

排他制御は `concurrency.group` で実現:

- `sync-catalog-prod`（増分）
- `sync-catalog-full-prod`（フル）
- `db-migrate-prod`（マイグレーション）

将来 AWS (RDS) 移行時も Secrets の `DATABASE_URL` を差し替えるだけでそのまま再利用可能。

### 3.6 イベント計測

| event_type | 必須フィールド | 用途 |
|------------|---------------|------|
| `view` | `slug` | 作品が画面に表示された |
| `play` | `slug` | 動画再生開始 |
| `detail_click` | `slug` | 詳細ボタンクリック |
| `affiliate_click` | `slug`, `affiliate_url` | 「購入する」ボタンクリック（収益核） |
| `search` | `search_query` | 検索ボックスへの入力確定 |

- `next_path` も任意で記録し、CTA の遷移先別 CVR 分析に使える
- `events` テーブルは `event_type`・`slug`・`search_query`・`created_at` にインデックス（マイグレーション `027a75b9c90d`）

### 3.7 サンプル動画 MP4 動的解決サービス（apps/resolver）

> **ステータス**: ✅ **本番稼働中**（Phase 4 Stage A 完了、2026-05-19 時点）。Xserver VPS 2GB Tokyo（`162.43.24.128`）にて `RESOLVER_CONCURRENCY=8` で稼働。バックフィルパイプライン（`resolve_sample_urls.py` + `resolve-sample-urls.yml`）も完成し、運用フロー全体が確立した。

#### 3.7.1 背景

`/feed` や作品詳細モーダルで「再生できない動画」が一部残る問題への恒久対策。DMM のサンプル動画 URL には複数の形式（`_mhb_w.mp4`, `_dmb_w.mp4`, `_sm_w.mp4`, `_dm_w.mp4`, `mhb.mp4`（アンダースコアなし）, `_sm_s.mp4`, `_dmb_s.mp4`, `_dm_s.mp4` 等）があるが、**実検証の結果すべての形式がブラウザで再生可能**であることが確認された。以前は suffix をクライアントであてずっぽうして学習キャッシュする方式を採っていたが、未知 suffix への追従や初回解決の遅延などの問題があったため、BFF 経由でヘッドレスブラウザに出させて動的に解決し、DB に書き戻して自動学習させる方式に統一した。

#### 3.7.2 確立された運用フロー

1. **`sync_catalog`**（2h cron / 手動 dispatch）が DMM API から取得 → `sample_movie_url=NULL` で保存
2. **`resolve_sample_urls`**（毎日 03:00 JST / 手動 dispatch）が NULL レコードを resolver 経由でバックフィル（`--concurrency 4`、並列処理）
3. ユーザー初回再生時に `sample_movie_url=NULL` のままヒットした場合、`apps/api` の `GET /movies/{slug}/resolve-mp4` が同期 resolve（実測 ~9 秒）。バックフィル済みであれば即座にキャッシュ返却
4. トークン期限切れ等で再生失敗 → `apps/web` が `DELETE /movies/{slug}/sample-url` を叩いて `sample_movie_url` を NULL に戻す → 次回 resolve で自然治癒

#### 3.7.3 責務

- DMM 作品の content_id を受け取り、Playwright Chromium で litevideo iframe を開いて `<video src>` を抽出して返す
- **状態を一切持たない**（DB アクセスしない、Redis も接続しない）。キャッシュと DB 書き戻しは `apps/api` 側責務
- 同時並列数を `RESOLVER_CONCURRENCY` の `asyncio.Semaphore` で制限し DMM CDN への負荷を押さえる（本番値 8）
- API キー認証により `apps/api` 以外からの呼び出しを拒否する
- 並列リクエストのデデュープ・短期キャッシュは `apps/api` 側の `resolver_client` 責務（v5.3 で実装）

#### 3.7.4 エンドポイント

| メソッド | パス | 役割 |
|----------|------|------|
| GET | `/health` | 死活監視（認証なし、Xserver 監視もしくは外部 uptime サービス用） |
| POST | `/resolve` | content_id から MP4 URL を動的解決。認証ヘッダー `Authorization: Bearer <RESOLVER_API_KEY>` 必須 |

**`POST /resolve` リクエスト / レスポンス例**

```http
POST /resolve HTTP/1.1
Authorization: Bearer <RESOLVER_API_KEY>
Content-Type: application/json

{
  "content_id": "nhd19",
  "affiliate_id": "<DMM_AFFILIATE_ID>"
}
```

```json
{
  "content_id": "nhd19",
  "mp4_url": "https://cc3001.dmm.co.jp/pv/<token>/nhd19_sm_s.mp4",
  "resolved_at": "2026-05-19T19:38:00+09:00",
  "elapsed_ms": 4521
}
```

失敗時は HTTP 404（content_id が存在しない）・502（litevideo の DOM から `<video>` が見つけられない）・504（タイムアウト）を返し、`apps/api` 側でログとリトライを制御する。

#### 3.7.5 内部構造

```
apps/resolver/
├── Dockerfile               # mcr.microsoft.com/playwright:python-v1.x-jammy ベース
├── pyproject.toml           # FastAPI + uvicorn + playwright + httpx
├── src/
│   ├── main.py              # FastAPI エントリポイント、API キー認証ミドルウェア
│   ├── browser_pool.py      # Chromium を起動時に一度だけ立ち上げて保持、context を貯蔵
│   ├── resolver.py          # litevideo iframe を開いて <video src> を抽出
│   └── config.py            # Pydantic Settings で環境変数読み込み
├── tests/
│   └── test_resolver.py     # モック DMM サーバーを立てて e2e 近いテスト
└── README.md
```

**Playwright ブラウザのライフサイクル**:

- FastAPI lifespan で `browser = await playwright.chromium.launch(headless=True)` を 1 回だけ実行
- リクエスト毎に `browser.new_context()` → `context.new_page()` して iframe を開き、終わったら context を close
- シャットダウン時に `await browser.close()` して Playwright を clean shutdown
- 同時リクエスト数は `asyncio.Semaphore` で上限をつける（**本番値 `RESOLVER_CONCURRENCY=8`**。実測で 8 並列 = 9.32 秒、メモリ 212 MiB / 1.465 GiB ≒ 14% と大きな余裕あり。1 並列でも 8.57s なので 1→4→8 で線形スループット）

**並列度ベンチマーク（2026-05-18 実測 / Xserver VPS 2GB Tokyo / `162.43.24.128`）**

| `RESOLVER_CONCURRENCY` | 1 リクエスト | 4 並列 | 8 並列 | コンテナメモリ |
|---|---|---|---|---|
| 2（変更前） | 8.2 s | 16.4 s（キュー詰まり） | – | 270 MiB |
| 4 | 8.57 s | 8.57 s | – | 198 MiB |
| **8（現行）** | **8.57 s** | **8.57 s** | **9.32 s** | **212 MiB** |

将来的にはメモリ余裕から 12〜16 並列まで上げる、または horizontal split で別 VPS を立てて L7 ロードバランサで分散する選択肢が取れる。

#### 3.7.6 apps/api 側の連携

本番エンドポイント **`GET /api/v1/movies/{slug}/resolve-mp4`** が `apps/api/app/api/v1/endpoints/movies.py` に実装済み（稼働中）。動作フローは以下の通り。

1. `movies.sample_movie_url` がある場合はそれをそのまま返す（`?force=true` 指定時はスキップして再解決）
2. `resolver_client._success_cache`（TTL 60 秒）に HIT すれば即返す（`force=true` の場合は飛ばす）
3. 同一 `content_id` への並列リクエストは `resolver_client._inflight: dict[str, asyncio.Future]`（`asyncio.Lock` 保護）で 1 本に集約し、最初のリクエストの Future を後続も await する → resolver には 1 回しか当たらない
4. 解決成功時、`mp4_url` を `_success_cache` に格納（TTL 60 秒）し、`movies.sample_movie_url` に書き戻して学習させる
5. 失敗時は `_inflight` のエントリを即クリアし、`future.exception()` を呼んで未取得警告を抑止する
6. クライアントに返す

PR #40 にて pytest のグローバル状態を毎回リセットするための `_reset_state_for_tests()` を resolver_client に追加し、`conftest.py` で autouse fixture として呼び出している。API テスト合計 46/46 pass（v5.6 時点、PR #50 で legacy 4 件削除後）。

#### 3.7.7 apps/web 側の連携

- `apps/web/components/feed/FeedItemVideo.tsx`（または `FeedItem.tsx`）の `<video onError>` ハンドラから `GET /api/v1/movies/{slug}/resolve-mp4` を呼び `src` を差し替えるロジック実装済み（PR #38 でマージ済み）
- 旧 `apps/web/lib/sampleUrlProbe.ts` の並列 `<video>` プローブ、`buildSampleUrlCandidates` / `switchSuffix` / `parseSampleUrl` のあてずっぽうロジックは **PR #39 で全削除済み**
- **Self-heal フロー（PR #47）**： `<video>` の `onError` を捕捉した際に、以下の 2 つを並行で走らせる。
  1. `invalidateSampleUrl(slug)` → `DELETE /api/v1/movies/{slug}/sample-url` を fire-and-forget で叩き、DB の `sample_movie_url` を NULL に戻す。以降この slug の `resolve-mp4` は必ず resolver 経由で新 URL を取りにいく。
  2. `resolveMp4Url(slug, {force:true})` → 現セッションで使う新 URL を即座に取得して `src` を差し替える。
- プリフェッチ側も同様で、`PrefetchVideoBuffer` の `<video onError>` から `usePrefetchVideoBytes.handleSlotError` へ失敗を伝搬し、`healedRef: Set<string>` で slug ごと 1 回限定で self-heal を走らせる（無限ループ防止）。
- **ORB 対策**：隠し `<video>` は `position:fixed; top:-9999px; left:-9999px; 100px×100px; opacity:0; pointer-events:none; z-index:-1` として画面外に配置。`1px / opacity:0` だと Chromium Opaque Response Blocking が cross-origin MP4 を弾くため、「画面外にある通常サイズのメディア要素」として判定される形に変更した。

#### 3.7.7.1 関連エンドポイント `DELETE /api/v1/movies/{slug}/sample-url`（PR #47）

- レスポンス：`204 No Content`。 認証不要、レートリミット未設定（今後必要であれば追加予定）。
- 振る舞い：`movies.sample_movie_url` を NULL に戻すだけのシンプルな処理。`movies` レコードそのものは保持される。
- 出し手：クライアント（`apps/web`）の `<video>` エラーを検知した self-heal フローからのみ叩かれる想定。ジョブ・手動オペとしては予定なし。
- テスト：`apps/api/tests/test_invalidate_sample_url.py` に 3 件（成功 / 存在しない slug / すでに NULL のケース）追加し API 全体 46/46 pass。

#### 3.7.8 デプロイ先（Stage A） — **稼働中の実構成**

- **Xserver VPS 2GB Tokyo**（1 インスタンス、Ubuntu 22.04 + Docker）
- **IP**: `162.43.24.128`（`ssh ubuntu@162.43.24.128`）
- **コンテナイメージ**: `shortvideo/resolver:latest`（Docker Hub）
- **コンテナ名**: `resolver`、**ポートマッピング**: `80:8080`
- **リソース制限**: `--memory=1500m --memory-swap=2g`
- **再起動戦略**: `--restart unless-stopped`
- **.env ファイル パス**: `/home/ubuntu/short-video-media/apps/resolver/.env`
- **`RESOLVER_CONCURRENCY=8`**（asyncio.Semaphore、Playwright Chromium プール共有）
- ドメインは現状未使用（VPS 生 IP を `RESOLVER_BASE_URL` に直接指定、Bearer 認証で防護）。将来的に Cloudflare 経由のサブドメインで TLS 終結に切り替える可能性あり。
- `apps/api`（Railway）からの呼び出しは `RESOLVER_API_KEY` の Bearer 認証で保護（Railway は送信元 IP が可変のため IP ホワイトリストは未適用）

**コンテナ再生成手順（環境変数を変えたとき）**

`docker restart` では `--env-file` の値は再読み込みされない。環境変数の変更を反映するには必ず `rm` + `run` でコンテナを再生成する。

```bash
docker stop resolver && docker rm resolver
docker run -d --name resolver --restart unless-stopped \
  --memory=1500m --memory-swap=2g -p 80:8080 \
  --env-file ~/short-video-media/apps/resolver/.env \
  shortvideo/resolver:latest
```

---

## 4. データモデル（現状コードに同期）

### 4.1 テーブル一覧

| テーブル | 概要 |
|----------|------|
| `movies` | 作品本体（FANZA 識別子 3 種、画像・動画 URL、価格、日付、レビュー、制作情報） |
| `actresses` | 女優（FANZA actress_id、slug、サムネ、＋ DMM 女優 API 由来プロフィール 13 列） |
| `genres` | ジャンル |
| `series` | シリーズ |
| `goods` | 女優グッズ（FANZA mono/goods フロア。動画固有カラム `sample_movie_url` / `sample_embed_url` / `series_id` 等は持たない） |
| `movie_actresses` | 多対多中間（`position` で並び順保持） |
| `movie_genres` | 多対多中間 |
| `actress_goods` | 女優×グッズの多対多中間 |
| `events` | 計測イベント |
| `users` | 内部 User（個人情報なし。`id`・`created_at`・`last_seen_at` のみ） |
| `identities` | provider × sub_hash の認証情報 |
| `bookmarks` | ユーザーのブックマーク（複合 PK: user_id × movie_id） |
| `view_histories` | 視聴履歴（user_id × movie_id × view_count × last_viewed_at） |

### 4.2 `movies` テーブル（抜粋）

| 列 | 型 | 備考 |
|----|----|------|
| `id` | uuid (str PK) | |
| `content_id` | str, unique, indexed | FANZA 商品 ID |
| `product_id` | str, indexed | 品番 |
| `maker_product` | str | メーカー品番 |
| `title` | str, not null | |
| `slug` | str, unique, indexed, not null | |
| `description` | text | |
| `volume` | int | |
| `image_url_list` / `image_url_large` | str | |
| `sample_movie_url` | str | MP4 直リンク（`<video src>`）。`sync_catalog` は NULL で INSERT し、resolver 経由の書き戻しのみで更新する |
| `sample_embed_url` | str | 埋め込みプレイヤー URL（`<iframe src>`） |
| `affiliate_url` / `affiliate_url_en` | str | |
| `price_list` | JSONB | `list_price`・`sale_price`・`rental_price`・`delivery_price` |
| `price_min` | int | |
| `release_date` / `delivery_date` / `rental_start_date` / `primary_date` | date | `primary_date` は indexed、フィード・ランキングのソートキー |
| `review_count` / `review_average` | int / Numeric(3,2) | |
| `director_name` / `label_name` / `maker_name` | str | |
| `series_id` | FK → series.id | `ondelete=SET NULL` |
| `is_visible` | bool | 運用フラグ |

リレーション:

- `series`: `lazy="joined"`（1 本の JOIN で取れるため）
- `genres` / `actresses`: `lazy="selectin"`（多対多は IN 句で一括取得）

> フィード用途では `series` のみ joined、`genres` / `actresses` は selectin の方針で統一。

### 4.3 `actresses` テーブル

DMM 女優検索 API のレスポンスを保持するため、以下のプロフィール列を追加済み（すべて nullable）:

`ruby`・`bust`・`cup`・`waist`・`hip`・`height`・`birthday`・`blood_type`・`hobby`・`prefectures`・`image_url_small`・`image_url_large`・`dmm_list_url`

`sync_catalog` は新しい女優を作品から見つけたら、ジョブ内で DMM 女優検索 API を叩いて上記列を埋める。

### 4.4 認証関連テーブル

```text
users
  id (uuid)
  created_at
  last_seen_at

identities
  id (uuid)
  user_id (FK → users.id, CASCADE)
  provider ("twitter" | "discord")
  sub_hash (SHA-256(provider:sub:APP_USER_SALT) の hex 64 文字)
  UNIQUE (provider, sub_hash)

bookmarks
  PK (user_id, movie_id)
  created_at (indexed DESC)

view_histories
  PK (user_id, movie_id)
  last_viewed_at (indexed DESC)
  view_count (default 1)
```

### 4.5 Alembic マイグレーション一覧

| revision | 日付 | 内容 |
|----------|------|------|
| `8965394ad436` | 2026-05-12 | init |
| `a1b2c3d4e5f6` | 2026-05-12 | add `sample_video_url` to movies |
| `fanza_schema_v2` | 2026-05-13 | FANZA スキーマ第 2 版 |
| `add_missing_columns` | 2026-05-13 | 不足カラム補充 |
| `sync_models_to_db` | 2026-05-13 | コード/DB の差分解消 |
| `e9d2e36472ae` | 2026-05-13 | `fanza_id` → `content_id` リネーム |
| `027a75b9c90d` | 2026-05-17 | events に `search_query`・`created_at` インデックス |
| `4f81a2b95c0e` | 2026-05-17 | users / identities / bookmarks / view_histories 追加 |
| `8a3c1f2e9d04` | 2026-05-17 | actresses にプロフィール列 13 種追加 |
| `6c7d92a4f1b8` | 2026-05-18 | フィード／ランキング／イベント集計用の複合 index 追加（`is_visible × primary_date` 等） |
| `b2c3d4e5f6a7` | 2026-05-18 | `goods` / `actress_goods` テーブル追加（女優グッズを Movie とは別管理に分離） |

---

## 5. インフラ・運用

### 5.1 ローカル開発

```bash
make setup        # .env コピー + pnpm install
make dev          # DB + API を docker compose up
make migrate      # alembic upgrade head
make fetch        # sync_catalog を 1 回手動実行
make test-api     # pytest
make db-shell     # psql 起動
```

`infra/docker/docker-compose.yml` には `db` と `api` の 2 サービス。`apps/jobs` は `--profile jobs` で `make fetch` から起動。

### 5.2 本番

| 役割 | サービス | 備考 |
|------|---------|------|
| Web | Vercel | Next.js 15.3 |
| API | Railway | `apps/api/Dockerfile` で `uvicorn app.main:app`。lifespan で `alembic upgrade head` 自動実行 |
| DB | Railway Postgres | 将来 AWS RDS へ移行予定 |
| Jobs | GitHub Actions（cron）／ Railway（手動） | `apps/jobs/Dockerfile` は Playwright + Chromium 同梱（130MB+） |
| Resolver （サンプル動画 MP4 動的解決） | **Xserver VPS 2GB Tokyo（`162.43.24.128`、稼働中）** | `RESOLVER_CONCURRENCY=8`、メモリ上限 1500m + swap 2g、`shortvideo/resolver:latest`、`--restart unless-stopped`。実質月額 ¥936（12 ヶ月一括キャッシュバック適用後）。将来的には Phase 4 Stage B で AWS Tokyo（Lambda Function URL or Fargate Spot）へ移植 |

### 5.3 環境変数

#### apps/web

| 変数 | 用途 |
|------|------|
| `NEXT_PUBLIC_SITE_URL` | 自サイト URL（SEO・絶対 URL 生成用） |
| `NEXT_PUBLIC_API_BASE_URL` | FastAPI のパブリック URL |
| `NEXT_PUBLIC_VERCEL_ENV` | `development` / `preview` / `production` |
| `INTERNAL_API_TOKEN` | サーバー間通信用トークン（必要に応じて） |
| `INTERNAL_API_BASE_URL` | 内部から API を叩く場合の URL（プライベートネットワーク移行時に使用） |
| `AUTH_SECRET` | Auth.js 署名鍵 |
| `AUTH_TWITTER_ID` / `AUTH_TWITTER_SECRET` | Twitter OAuth |
| `AUTH_DISCORD_ID` / `AUTH_DISCORD_SECRET` | Discord OAuth |

#### apps/api / apps/jobs

| 変数 | 用途 |
|------|------|
| `DATABASE_URL` | Postgres 接続文字列 |
| `DMM_API_ID` | DMM Webservice の API ID |
| `DMM_AFFILIATE_ID` | DMM API 呼び出し用 ID（末尾 -990〜-999） |
| `DMM_LINK_AFFILIATE_ID` | 購入ページに付ける af_id（末尾 -001 等） |
| `AUTH_SECRET` | exchange JWT 検証用 |
| `JWT_SECRET` / `JWT_AUDIENCE` | 内部 User JWT |
| `APP_USER_SALT` | sub_hash 用 SALT（**絶対に変更しない**） |
| `RESOLVER_BASE_URL` | apps/api / apps/jobs から apps/resolver を呼ぶためのベース URL。現行本番値は `http://162.43.24.128`（VPS 生 IP、ポート 80） |
| `RESOLVER_API_KEY` | apps/api / apps/jobs → apps/resolver の Bearer トークン。resolver 側と同じ値を設定 |
| `RESOLVER_TIMEOUT_MS` | resolve 呼び出しのタイムアウト（デフォルト 25000ms。Playwright + DMM iframe の実測 8.5 秒に余裕を持たせる） |
| `RESOLVER_SUCCESS_CACHE_TTL_SEC` | `resolver_client._success_cache` の TTL（デフォルト 60 秒、v5.3 で追加） |

#### apps/resolver

| 変数 | 用途 |
|------|------|
| `RESOLVER_API_KEY` | Bearer 認証用の共有トークン（`apps/api` 側と同じ値） |
| `DMM_AFFILIATE_ID` | litevideo iframe を開く際に必要な affiliate_id（リクエスト body で上書き可能だがデフォルトとして使う） |
| `RESOLVER_CONCURRENCY` | `asyncio.Semaphore` の上限（**本番値 8**、デフォルト 2）。メモリ 1.5 GiB で 8 並列でも 14% 程度の利用率のため、12〜16 まで拡張余地あり |
| `RESOLVER_NAV_TIMEOUT_MS` | iframe へのナビゲーションタイムアウト（デフォルト 15000） |
| `RESOLVER_WAIT_VIDEO_TIMEOUT_MS` | `<video>` 要素出現待ちタイムアウト（デフォルト 8000） |

---

## 6. ロードマップ

### Phase 1：FANZA 審査通過 ✅ 完了

- [x] 独自ドメイン取得・Vercel 設定
- [x] TikTok 風縦スクロール UI 完成
- [x] `/privacy` ページ作成
- [x] `/law` ページ作成
- [x] `/contact` ページ作成
- [x] モックコンテンツ 10〜20 件追加 → DMM 実データに置換
- [x] FANZA 審査申請・**通過**

### Phase 2：コンテンツ量確保＆品質向上（進行中）

- [x] `sync_catalog.py` 本実装（DMM ItemList API 全件取得）
- [x] GitHub Actions による 2h 増分 / 月 1 フル取得の cron 稼働
- [x] `extract_mp4_urls.py`（Playwright で MP4 直リンク抽出）
- [x] フロア別擬似ジャンル（アマチュア / プロ女優）自動付与
- [x] サンプル動画 URL の学習キャッシュ・並列プローブ → Phase 4 Stage A 完了に伴い PR #39 で **全削除済み**（resolver 経由の学習方式に統一）
- [x] 認証 / マイページ（ブックマーク・視聴履歴）
- [x] 女優詳細ページ＋ DMM 女優プロフィール統合
- [x] ホーム画面集約 API・ランキング・検索数の高いジャンル
- [x] PR #2（FeedItem 分割リファクタ）のマージ
- [ ] `packages/shared/*` を最新スキーマに同期
- [ ] `apps/jobs` Dockerfile の検証と Railway での MP4 抽出ジョブ運用

### Phase 3：SEO・流入強化（1〜2 ヶ月後）

- [ ] OGP・メタタグの動的生成（作品ごと・女優ごと）
- [ ] `sitemap.xml` の作品・女優・ジャンルへの動的反映
- [ ] 関連作品レコメンド（`generate_related.py` 新規作成）
- [ ] Redis 導入＆ホーム / ランキング応答のキャッシュ（`rebuild_cache.py` 新規作成）
- [ ] `recompute_rankings.py` 新規作成によるランキング事前計算でレスポンス改善
- [ ] CI の拡充（既存 `api-ci.yml`・`jobs-ci.yml`・`web-ci.yml` への lint 追加・カバレッジ計測等）

### Phase 4：サンプル動画動的解決 ＋ AWS 移行・全自動化

#### Phase 4 Stage A：Xserver VPS Tokyo でサンプル動画動的解決を先行リリース ✅ 完了

スコープ: 「再生できない動画」問題を AWS 移行より先に解消する。VPS 上で `apps/resolver/` を立ち上げ、`apps/api` ・`apps/web` を BFF 設計に追従させ、バックフィルパイプラインで事前解決も完成させる。

- [x] **`apps/resolver/`** を新規作成（FastAPI + Playwright Chromium、`POST /resolve` + `GET /health`）
  - [x] `apps/jobs/src/extract_mp4_urls.py::extract_mp4_url` のコアロジックを `apps/resolver/src/resolver.py` にコピーし、リクエスト駆動型に最適化（ブラウザ起動コストを起動時に一回だけ払う）
  - [x] Bearer 認証ミドルウェア（`RESOLVER_API_KEY`）
  - [x] `Dockerfile`（`mcr.microsoft.com/playwright:python-v1.x-jammy` ベース）
  - [x] `pyproject.toml` で依存をシングルソース化
  - [x] ユニットテスト（resolver 関数の正常系 / 例外系 / Bearer 認証）
- [x] **Xserver VPS 2GB Tokyo を契約**（12 ヶ月一括、実質 ¥11,232 / 月均 ¥936）
  - [x] Ubuntu 22.04 テンプレートでセットアップ
  - [x] SSH 鍵認証のみ許可、`ufw` で必要ポートのみ開放
  - [x] Docker を導入
  - [ ] Cloudflare 経由のサブドメイン化（後回し、当面は VPS 生 IP `162.43.24.128` ＋ Bearer 認証で運用）
- [x] **`apps/api`** に `GET /api/v1/movies/{slug}/resolve-mp4` を追加し、`movies.sample_movie_url` をキャッシュとして使い、ミス時に VPS へプロキシするロジックを実装（PR #40 で in-flight デデュープ + 60s 短期キャッシュも追加）
- [x] **`apps/web`** の `<video onError>` ハンドラを `/api/v1/movies/{slug}/resolve-mp4` 呼び出しに置き換える
- [x] ステージング / 本番で実際に `_sm_s` やその他未知 suffix の作品が再生できることを検証（実測: nhd19 = 8.5s、mmmb181 = 8.2s、8 並列 = 9.32s）
- [x] 検証完了後、`apps/jobs/src/sync_catalog.py::_build_sample_mp4_url` ／ `apps/web/components/FeedItem.tsx::buildSampleUrlCandidates` / `switchSuffix` / `parseSampleUrl` ／ `apps/web/lib/sampleUrlProbe.ts::probeSampleUrls` を **PR #39 で全削除**
- [x] `apps/api/app/api/v1/endpoints/movies.py::_SAMPLE_URL_RE` および `POST /api/v1/movies/{slug}/sample-url` を **PR #39 で削除**（緩和ではなく resolver 統合により廃止）
- [x] **PR #40 で in-flight デデュープ + 60 秒短期キャッシュを追加**し、同一 content_id への並列 force リトライによる resolver 過負荷を防止
- [x] **VPS の `RESOLVER_CONCURRENCY` を 2 → 8 に増強**（8 並列 = 9.32s、メモリ 212 MiB ≒ 14%、十分な余裕あり）
- [x] **`resolve_sample_urls.py` バックフィルジョブ + `resolve-sample-urls.yml` workflow を追加（PR #49）** — 毎日 03:00 JST に NULL レコードを自動バックフィル。初回実施: 175 件を約 7 分で処理、NULL=0 達成
- [x] **legacy URL ガード撤廃（PR #50）** — 全 URL 形式が再生可能と判明したため `_UNPLAYABLE_SUFFIX_RE` / `_is_unplayable_legacy_url()` / `--include-legacy` / `LEGACY_PATTERN` をすべて削除。API テスト 46 pass（legacy 4 件削除）
- [ ] モニタリング：UptimeRobot 等で `/health` を 1 分間隔で監視、エラー率・実行時間をログ集約（未着手）

#### Phase 4 Stage B：AWS 移行・全自動化（3 ヶ月後〜）

- [ ] ECR + ECS（または App Runner）に API を移行
- [ ] EventBridge Scheduler ＋ ECS Task で `sync_catalog` / `resolve_sample_urls` を実行
- [ ] RDS（Postgres）へ DB 移行
- [ ] CloudFront ＋ Vercel 切り替え判断
- [ ] Secrets Manager で `DMM_*` 系・`JWT_*` 系・`APP_USER_SALT`・`RESOLVER_API_KEY` を一元管理
- [ ] CloudWatch Logs / Alarms で 24/7 監視
- [ ] **【継続 TODO】`apps/resolver/` を Xserver VPS から AWS Tokyo へ移植**

  Stage A ではすでに `apps/resolver/` は完成して Xserver VPS Tokyo 上で稼働し、未知 suffix の作品も含めて「再生できない動画」問題は解消済み。Stage B では「ホストを AWS Tokyo に移す」フェーズに限定されるため、`apps/api` / `apps/web` 側は原則ノータッチ（`RESOLVER_BASE_URL` の差し替えのみ）。

  **背景と設計根拠（実検証で確定した事実）**

  - DMM Affiliate API の `sampleMovieURL.size_720_480` は HTML プレイヤー（iframe）の URL であり、`<video src>` には使えない。
  - 実 MP4 ファイルは `https://cc3001.dmm.co.jp/pv/<token>/<cid><suffix>.mp4` 形式で配信されている。
  - suffix には `_mhb_w`, `_dmb_w`, `_sm_w`, `_dm_w`, `mhb`（アンダースコアなし）, `_sm_s`, `_dmb_s`, `_dm_s` 等複数の形式があるが、**いずれもブラウザで再生可能**（旧来の「`_mhb_w` / `_dm_w` は ORB エラーで再生不可」という前提は誤りであった）。
  - 取得には日本 IP が必須（DMM CDN は海外 IP に GeoIP 403）。Xserver VPS Tokyo でも AWS Tokyo でもこの要件は満たされる。
  - 取得済みの `/pv/<token>/...mp4` URL は、少なくとも **32 日以上** 同一トークンで 200 OK を返す（CloudFront `age: 2796484` 秒で実測）。
  - `last-modified` は実体ファイルのもので 11 年前から不変、CORS は `Access-Control-Allow-Origin: *` で全開放。
  - つまり「動的署名」ではなく **長期キャッシュ可能なパス** に近い性質を持つ。

  **ヘッドレスブラウザの実行位置以外は同一のアーキテクチャとして設計しているため、Stage B は Xserver VPS を AWS コンポーネントに置換するだけで達成できる:**

  ```
  ┌──────────────────────────────────────────────┐
  │ Vercel (web)                                  │
  │ ① <video src={DB.sample_movie_url}> で再生   │
  │ ② onError → GET /movies/{slug}/resolve-mp4   │
  │    で動的取得 → <video> 差し替え             │
  └───────────────┬───────────────────────────────┘
                  │ ②（再生失敗時のみ）
                  ▼
  ┌───────────────────────────────────────────────┐
  │ Railway api (FastAPI)                         │
  │ GET /movies/{slug}/resolve-mp4                │
  │ - movies.sample_movie_url をキャッシュとして使用 │
  │   （Phase 3 で Upstash Redis を上位キャッシュ追加） │
  │ - ミス時に RESOLVER_BASE_URL へプロキシ         │
  │ - 取得した URL を movies.sample_movie_url に    │
  │   書き戻して学習                              │
  └───────────────┬───────────────────────────────┘
                  │ HTTPS RPC（稀）
                  ▼
  ┌───────────────────────────────────────────────┐
  │ apps/resolver                                 │
  │   Stage A: Xserver VPS 2GB Tokyo               │
  │   Stage B: AWS Tokyo (Lambda Function URL      │
  │           or Fargate Spot)                    │
  │ - Playwright Chromium で litevideo iframe を   │
  │   開いて <video src> を取得して返すだけ        │
  │ - DB アクセス無し・状態なし（純粋な解決器）    │
  └───────────────────────────────────────────────┘
  ```

  **Stage B 固有のサブタスク（`apps/resolver/` の AWS 移植に限定）:**

  - [ ] AWS Tokyo 側のホスト形態を Lambda Function URL（`chrome-aws-lambda` / `@sparticuz/chromium`）と Fargate Spot 常駐のどちらにするか性能評価（コールドスタート 3〜8 秒 / 常駐 0 秒のトレードオフ・より低頻度なら Lambda がコスト有利）
  - [ ] Lambda 採用時: 既存 `apps/resolver/Dockerfile` を Lambda Container Image 形式に調整し、Function URL と IAM Resource Policy を Terraform / AWS CDK で IaC 化
  - [ ] Fargate 採用時: ECS Cluster 上で 1 タスク常駐、ALB or API Gateway HTTP API 越しで公開
  - [ ] Xserver VPS の `apps/resolver` を AWS へデプロイし、`apps/api` の `RESOLVER_BASE_URL` を差し替えてステージングで実際に動作検証
  - [ ] AWS Tokyo の出口 IP に対する DMM のレート制限挙動を観測（Playwright 同時実行数の上限決定）
  - [ ] AWS での安定動作を 1〜2 週間確認したら Xserver VPS を解約（またはフェイルオーバー用に依然保持）

  **未確定 / 継続調査事項:**

  - `/pv/<token>/...` の token 寿命の上限（現時点で 32 日以上は確定、年単位かどうかは未確認）
  - Lambda + Playwright の同時実行数とコールドスタート許容範囲のユーザー体験影響評価

---

## 7. リスクと制約

| リスク | 内容 | 対応 |
|--------|------|------|
| GeoIP ブロック | DMM CDN は海外 IP に `not-available-in-your-region` を返すため、AWS リージョン選定・NAT Gateway の出口 IP に注意 | 日本リージョン（ap-northeast-1）固定 |
| アフィリエイト無効リンク | DMM API が返す `al.fanza.co.jp` URL は新規アカウントで無効 | `sync_catalog` 側で `af_id` 付き `dmm.co.jp` URL を組み立て |
| MP4 URL のトークン失効 | 実測により少なくとも 32 日は同一 URL で 200 OK を返すことが確認できた（CloudFront `age: 2796484` 秒で実測、CORS 全開放）。また `_mhb_w`, `_dm_w` 等すべての suffix 形式でブラウザ再生可能であることが確認済み（「ORB エラーで再生不可」という旧前提は誤りだった）。DB の `sample_movie_url` が失効した場合は、self-heal フロー（`DELETE /movies/{slug}/sample-url` → `resolve-mp4` 再取得）で自動復旧する。バックフィルジョブ（毎日 03:00 JST）が NULL レコードを先回りで解消するため、初回再生時の待機も最小化される | Phase 4 Stage A で `apps/resolver/` を Xserver VPS Tokyo に立ち上げ、BFF + バックフィルパイプライン + クライアント onError フォールバックで未知 suffix も含めて動的に解決。Stage B で AWS Tokyo へ移植（§6 Phase 4 参照） |
| Resolver （VPS）の単一障害点 | Stage A で `apps/resolver/` は Xserver VPS 1 台（`162.43.24.128`）のみで稼働し、これが落ちると「NULL の作品」が再び再生不可になる（バックフィル済み URL の作品は DB の `sample_movie_url` 経由で引き続き再生可能）。バックフィルパイプライン完成により既存作品の大半は NULL=0 の状態を維持できているため、VPS 停止の影響は新規追加分のみに限定される | （1）`apps/api` の `resolver_client` に in-flight デデュープと 60 秒短期キャッシュを実装済み（PR #40）により、リトライ風暴がオリジンを直撃しない。（2）`--restart unless-stopped` で Docker レベルで自動再起動。（3）UptimeRobot による 1 分間隔ヘルスチェックは未設定（TODO）。（4）Stage B の AWS 移行で恒久的に解決（Lambda ならマルチ AZ 冗長、Fargate も multi-AZ 可） |
| `RESOLVER_API_KEY` の漏洩リスク | セッション中に対話の流れで `RESOLVER_API_KEY` の値がチャットに 1 度貼られた可能性あり。漏洩した場合、第三者から Xserver VPS の `/resolve` を直接叩かれ、`apps/resolver` のリソース消費・DMM CDN への負荷増加を招く | `openssl rand -hex 32` で新規シークレットを発行し、Xserver VPS `.env`（`/home/ubuntu/short-video-media/apps/resolver/.env`）と Railway 環境変数（`apps/api`）を同時に差し替えてから VPS コンテナを `docker rm` + `docker run --env-file` で再生成する。今後はチャットで API キーを貼らず `.env` または `/tmp/` のみで扱う |
| Xserver VPS から AWS への移行コスト | 契約は 12 ヶ月一括（初回 ¥14,040，キャッシュバック後実質 ¥11,232）のため、Phase 4 Stage B の AWS 移行が見込みより早く進んだ場合に長期契約分が無駄になる可能性 | `apps/resolver/Dockerfile` を Lambda Container Image 互換に設計しておき、Stage B では「デプロイ先を差し替えるだけ」に収める。また、Stage B で AWS の安定動作を 1〜2 週間確認した後に VPS を解約するという二重運用期間を見込んでおく |
| Provider 個人情報 | OAuth 経由でメール・名前等を取得できるが、規約・GDPR 観点で保持しない方針 | `sub_hash` のみ保持。`APP_USER_SALT` は絶対に変更しない |
| ランキング負荷 | 現在は API リクエスト時に都度算出 | Phase 3 で `recompute_rankings.py` ＋ Redis にバッチ化 |
| asyncpg の tz-aware エラー | `TIMESTAMP WITHOUT TIME ZONE` に tz-aware datetime を渡すと `DataError` | モデル側で `replace(tzinfo=None)` を統一 |

---

## 8. 関係ドキュメント

- `docs/minutes.md`: 開発議事録
- `docs/architecture.md`（要記述）: システム構成図、データフロー
- `docs/db-schema.md`（要記述）: ER 図、列定義
- `docs/api-contract.md`（要記述）: OpenAPI 由来のエンドポイント仕様
- `docs/environments.md`（要記述）: 環境変数一覧・Secrets 管理ポリシー
- `docs/roadmap.md`（要記述）: 本書 §6 と連動させた中長期ロードマップ
- `docs/requirements_definition_v5_0.md`: 本書のベースとなった旧バージョン（v5.0〜v5.5 の変更履歴を含む）
