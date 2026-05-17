"""sample-url 報告 API の正規表現単体テスト。

旧形式 (litevideo/freepv/...) と新形式 (pv/<token>/...) の両方を受理することを保証する。
"""
from app.api.v1.endpoints.movies import _SAMPLE_URL_RE


def test_accepts_legacy_litevideo_paths() -> None:
    """旧形式の cc3001.dmm.co.jp/litevideo/freepv/... を受理する。"""
    valid = [
        "https://cc3001.dmm.co.jp/litevideo/freepv/n/nas/nask00405/nask00405_mhb_w.mp4",
        "https://cc3001.dmm.co.jp/litevideo/freepv/s/smj/smjx231/smjx231mhb.mp4",
        "https://cc3001.dmm.co.jp/litevideo/freepv/h/ho1/ho11992/ho11992_dmb_w.mp4",
    ]
    for url in valid:
        assert _SAMPLE_URL_RE.match(url), f"should accept: {url}"


def test_accepts_signed_pv_paths() -> None:
    """新形式 (Playwright 抽出ジョブが取得する pv/<token>/...) を受理する。"""
    valid = [
        "https://cc3001.dmm.co.jp/pv/abc123XYZ_-Token/nask00405mhb.mp4",
        "https://cc3001.dmm.co.jp/pv/tok_en-1/sun00052a_mhb_w.mp4",
        "https://cc3001.dmm.co.jp/pv/SOMETOKEN/abc00001.mp4",
    ]
    for url in valid:
        assert _SAMPLE_URL_RE.match(url), f"should accept: {url}"


def test_rejects_malicious_or_wrong_hosts() -> None:
    invalid = [
        "https://evil.example.com/litevideo/freepv/n/nas/nask00405/nask00405_mhb_w.mp4",
        "http://cc3001.dmm.co.jp/pv/x/y.mp4",  # http 不可
        "https://cc3001.dmm.co.jp/other/path/movie.mp4",
        "javascript:alert(1)",
        "",
        "https://cc3001.dmm.co.jp/pv/abc/movie.exe",
    ]
    for url in invalid:
        assert not _SAMPLE_URL_RE.match(url), f"should reject: {url}"
