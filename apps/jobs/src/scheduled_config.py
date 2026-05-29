"""定期実行 (cron) で何を取得するかを環境変数で設定するためのヘルパ。

`sync_catalog` / `sync_actress_profiles` の CLI フラグは引き続き最優先される。
CLI で値を指定しなかった場合に限り、対応する環境変数を見にいき、
それも未設定なら従来のハードコードされたデフォルト値を使う。

これにより GitHub Actions の workflow_dispatch / cron では CLI 引数を渡さず、
VPS 側 `infra/xserver/.env` (docker compose の `env_file`) で対象を切り替える
運用ができる。

サポートする環境変数:
==============================================================
sync_catalog (cron で「最新を取り続ける」用)
--------------------------------------------------------------
SYNC_CATALOG_HITS           : int (デフォルト: 100)
                              1 フロアあたり取得件数
SYNC_CATALOG_FLOORS         : カンマ区切り (例: "videoa,videoc")
                              有効値: videoa / videoc / goods
                              未設定なら sync_catalog の mode 別デフォルトを使う
SYNC_CATALOG_LOOKBACK_DAYS  : int (任意、未設定なら API のフルレンジから sort=date desc で取得)
                              起動時に毎回 (今日 - N 日) を gte_date として API に渡す。
                              「最新だけ取りたいが、念のため過去 N 日も拾いたい」
                              用途に使う。固定日付ではなく相対値にすることで
                              cron が走り続ける限り取得対象も自動で前進する。
SYNC_CATALOG_DRY_RUN        : "1"/"true" で dry-run

NOTE:
  - `--mode full` / `--start-date` / `--end-date` / `--gte-date` / `--lte-date` といった
    固定日付の CLI フラグは引き続き存在するが、cron 用の env ではない。
    ブートストラップや手動バックフィル時にだけ使う想定。
  - 固定日付 env (SYNC_CATALOG_GTE_DATE 等) はあえて受け付けない。設定したまま
    放置すると cron が古い日付ウィンドウに固定されて最新を取りこぼすため。

sync_actress_profiles
--------------------------------------------------------------
SYNC_ACTRESS_LIMIT        : int (未設定なら全件処理)
SYNC_ACTRESS_ONLY_MISSING : "1"/"true"/"yes" で --only-missing 相当
SYNC_ACTRESS_DRY_RUN      : "1"/"true" で dry-run
"""
from __future__ import annotations

import os
from datetime import datetime
from typing import Iterable


# 有効な floor 名 (sync_catalog.FLOORS と一致させる)
_VALID_FLOORS: frozenset[str] = frozenset({"videoa", "videoc", "goods"})

_TRUTHY: frozenset[str] = frozenset({"1", "true", "yes", "on"})
_FALSY: frozenset[str] = frozenset({"0", "false", "no", "off", ""})


class EnvConfigError(ValueError):
    """環境変数のパース失敗 (値が不正、想定外の floor など)。

    呼び出し側で SystemExit にラップして起動を止める想定。
    """


def _strip(value: str | None) -> str | None:
    if value is None:
        return None
    s = value.strip()
    return s or None


def env_str(name: str) -> str | None:
    """env を文字列で返す (空文字 / 未設定は None)。"""
    return _strip(os.getenv(name))


def env_int(name: str, *, minimum: int | None = None) -> int | None:
    """env を int で返す。空 / 未設定は None。

    パース失敗時は EnvConfigError。`minimum` 指定時はそれ以上の値か検証。
    """
    raw = env_str(name)
    if raw is None:
        return None
    try:
        value = int(raw)
    except ValueError as e:
        raise EnvConfigError(f"{name}: int に変換できません (got {raw!r})") from e
    if minimum is not None and value < minimum:
        raise EnvConfigError(
            f"{name}: {minimum} 以上で指定してください (got {value})"
        )
    return value


def env_bool(name: str, *, default: bool = False) -> bool:
    """env を bool で返す。未設定 / 空文字なら `default`。"""
    raw = os.getenv(name)
    if raw is None:
        return default
    s = raw.strip().lower()
    if s == "":
        return default
    if s in _TRUTHY:
        return True
    if s in _FALSY:
        return False
    raise EnvConfigError(
        f"{name}: bool として解釈できません (got {raw!r}); "
        f"true/false/1/0/yes/no を指定してください"
    )


def env_date_iso(name: str) -> str | None:
    """env を "YYYY-MM-DD" 形式で返す (パース検証だけ行い文字列のまま返す)。

    呼び出し側がさらに加工 (T00:00:00 付与など) するため、整形済みの文字列を返す。
    """
    raw = env_str(name)
    if raw is None:
        return None
    try:
        datetime.strptime(raw, "%Y-%m-%d")
    except ValueError as e:
        raise EnvConfigError(
            f"{name}: YYYY-MM-DD 形式で指定してください (got {raw!r})"
        ) from e
    return raw


def env_floor_list(
    name: str,
    *,
    valid: Iterable[str] = _VALID_FLOORS,
) -> list[str] | None:
    """env を「カンマ区切り floor 名 → list」に変換。

    - 未設定 / 空文字 → None (sync_catalog のデフォルト挙動に委ねる)
    - 値あり → 各要素を strip して lowercase。`valid` に含まれない要素があれば
      EnvConfigError。重複は保持順で除去。
    """
    raw = env_str(name)
    if raw is None:
        return None
    parts: list[str] = []
    seen: set[str] = set()
    invalid: list[str] = []
    valid_set = {v.lower() for v in valid}
    for token in raw.split(","):
        t = token.strip().lower()
        if not t:
            continue
        if t not in valid_set:
            invalid.append(t)
            continue
        if t in seen:
            continue
        seen.add(t)
        parts.append(t)
    if invalid:
        raise EnvConfigError(
            f"{name}: 未知の floor が含まれています: {invalid}; "
            f"有効値: {sorted(valid_set)}"
        )
    if not parts:
        # 全てが空白だった場合: 未設定と同じ扱い
        return None
    return parts


def env_choice(name: str, choices: Iterable[str]) -> str | None:
    """env を choices に限定した文字列で返す。"""
    raw = env_str(name)
    if raw is None:
        return None
    choices_list = list(choices)
    if raw not in choices_list:
        raise EnvConfigError(
            f"{name}: {choices_list} のいずれかを指定してください (got {raw!r})"
        )
    return raw
