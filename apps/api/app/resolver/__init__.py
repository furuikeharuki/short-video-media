"""DMM サンプル動画ページから MP4 直リンクを抽出するパッケージ。

以前は Playwright で iframe をレンダリングして MP4 URL を取得していたが、
DMM 側の html5_player ページが ``var args = {...}`` 形式で MP4 URL を
そのまま埋めて返してくれることが分かったため、ピュア httpx で
in-process に解決する実装に切り替えた (resolver コンテナは廃止)。

主要モジュール:
    extractor: ``extract_mp4_url`` 本体と ResolveError サブクラス。

呼び出し元 (apps/api / apps/jobs) は ``app.services.resolver_client`` 経由で
in-flight デデュープ・短期キャッシュ付きの公開 API を使う。
"""
