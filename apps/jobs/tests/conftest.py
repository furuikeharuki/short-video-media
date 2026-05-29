"""SQLAlchemy の JSONB を JSON に差し替えて、SQLite ベースのテストでも
モデルがロードできるようにする。

apps/api 側のモデルは postgresql.JSONB を直接 import しているわけではなく、
`sqlalchemy.dialects.postgresql.JSONB` を mapped_column 経由で参照する。
テストで in-memory sqlite を使う場合、CREATE TABLE で JSONB は SQLite 方言が
レンダリングできずに CompileError になるため、import される前に置換する。
"""
import sqlalchemy.dialects.postgresql as _pg
from sqlalchemy import JSON as _JSON

_pg.JSONB = _JSON  # type: ignore[attr-defined]
