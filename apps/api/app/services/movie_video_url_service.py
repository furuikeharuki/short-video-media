"""サンプル動画 MP4 URL の「DB キャッシュ + 都度フォールバック」共通ロジック。

方針 (ユーザー要望):
  - 定期ジョブ (sync_video_urls) が低画質・高画質ともに DB に保存する。
  - 再生時 (resolve-mp4 endpoint / feed) は DB に URL があればそれを即返す
    (resolver を呼ばない = 高画質再生までのレイテンシを削減)。
  - DB に無い / 再生できない (force=true) ときだけ resolver で抽出し、
    取得できた新しい URL で DB を更新する。

このモジュールは endpoint / feed / jobs から共通で使う小さなヘルパを提供する。
resolver_client への薄いラッパで、`ResolvedMp4` の low/high フォールバック正規化と
`Movie` への永続化 (UPDATE) をまとめる。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie
from app.services import resolver_client

logger = logging.getLogger(__name__)


def _utcnow_naive() -> datetime:
    """tz-naive UTC (movies.sample_mp4_resolved_at は TIMESTAMP WITHOUT TIME ZONE)。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def normalize_resolved(
    resolved: resolver_client.ResolvedMp4,
) -> resolver_client.ResolvedMp4:
    """low/high が None のとき mp4_url にフォールバックした ResolvedMp4 を返す。

    フロント (低画質ファースト → 高画質スワップ) が常に low/high 両方を見るだけで
    済むよう、single-bitrate や抽出失敗時は両方を mp4_url に揃える。
    """
    mp4 = resolved.mp4_url
    low = resolved.low_mp4_url or mp4
    high = resolved.high_mp4_url or mp4
    return resolver_client.ResolvedMp4(mp4_url=mp4, low_mp4_url=low, high_mp4_url=high)


def stored_resolved(movie: Movie) -> resolver_client.ResolvedMp4 | None:
    """Movie に保存済みの MP4 URL があれば正規化して返す。無ければ None。

    「使える」判定は `sample_mp4_url` が入っていること。low/high が欠けていても
    mp4_url にフォールバックする。
    """
    mp4 = movie.sample_mp4_url
    if not mp4:
        return None
    low = movie.sample_low_mp4_url or mp4
    high = movie.sample_high_mp4_url or mp4
    return resolver_client.ResolvedMp4(mp4_url=mp4, low_mp4_url=low, high_mp4_url=high)


async def persist_resolved(
    db: AsyncSession,
    movie_id: str,
    resolved: resolver_client.ResolvedMp4,
    *,
    commit: bool = True,
) -> resolver_client.ResolvedMp4:
    """解決した MP4 URL を movies 行へ書き戻す (best-effort)。

    書き込みに失敗しても再生自体は継続させたいので、例外は飲んでログのみ。
    正規化済みの ResolvedMp4 を返す (呼び出し側がそのままレスポンスに使える)。

    Args:
        commit: True なら即 commit。バッチ更新したい呼び出し側は False にして
            最後にまとめて commit する。
    """
    normalized = normalize_resolved(resolved)
    try:
        await db.execute(
            update(Movie)
            .where(Movie.id == movie_id)
            .values(
                sample_mp4_url=normalized.mp4_url,
                sample_low_mp4_url=normalized.low_mp4_url,
                sample_high_mp4_url=normalized.high_mp4_url,
                sample_mp4_resolved_at=_utcnow_naive(),
            )
        )
        if commit:
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning(
            "failed to persist resolved mp4 urls for movie_id=%s", movie_id, exc_info=True
        )
        if commit:
            try:
                await db.rollback()
            except Exception:  # noqa: BLE001
                pass
    return normalized


async def persist_resolved_many(
    db: AsyncSession,
    resolved_by_movie_id: dict[str, resolver_client.ResolvedMp4],
) -> None:
    """複数 movie の解決結果を 1 トランザクションで書き戻す (best-effort)。

    feed の inline resolve で、レスポンス期限内に解決できた数件をまとめて
    永続化するために使う。1 件でも失敗したらまとめて rollback する
    (feed レスポンス自体は URL 同梱済みなので DB 書き込み失敗は致命ではない)。
    """
    if not resolved_by_movie_id:
        return
    now = _utcnow_naive()
    try:
        for movie_id, resolved in resolved_by_movie_id.items():
            normalized = normalize_resolved(resolved)
            await db.execute(
                update(Movie)
                .where(Movie.id == movie_id)
                .values(
                    sample_mp4_url=normalized.mp4_url,
                    sample_low_mp4_url=normalized.low_mp4_url,
                    sample_high_mp4_url=normalized.high_mp4_url,
                    sample_mp4_resolved_at=now,
                )
            )
        await db.commit()
    except Exception:  # noqa: BLE001
        logger.warning(
            "failed to persist resolved mp4 urls for %d movies",
            len(resolved_by_movie_id),
            exc_info=True,
        )
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
