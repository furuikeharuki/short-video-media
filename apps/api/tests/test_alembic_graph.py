"""Alembic マイグレーショングラフの最低限の健全性チェック。

サイクル無し / 単一 head / 各 revision がパースできる、を担保するだけの軽量テスト。
複数 head が放置されると本番デプロイ時に `alembic upgrade head` が
"Multiple head revisions are present" で失敗するため、PR 時点で気付けるようにする。
"""
from __future__ import annotations

from alembic.config import Config
from alembic.script import ScriptDirectory


def _get_script() -> ScriptDirectory:
    cfg = Config("alembic.ini")
    return ScriptDirectory.from_config(cfg)


def test_alembic_has_single_head() -> None:
    """alembic head が 1 本に収束していること。

    PR が並行で merge されると、両方が同じ down_revision を指していた場合に
    multiple heads になる。次に merge する人が必ず merge revision を作る運用に
    するために、テストとしても固定しておく。
    """
    script = _get_script()
    heads = script.get_heads()
    assert len(heads) == 1, (
        f"Expected exactly 1 alembic head, got {len(heads)}: {heads}. "
        "If two PRs added independent migrations on the same parent, "
        "create a merge revision: `alembic merge -m '...' <head1> <head2>`."
    )


def test_alembic_all_revisions_parse() -> None:
    """全 revision を walk できる (循環なし / 親が存在する)。"""
    script = _get_script()
    revs = list(script.walk_revisions())
    assert revs, "No alembic revisions found."
    # walk_revisions は循環があれば例外を出す。ここまで到達すれば OK。
