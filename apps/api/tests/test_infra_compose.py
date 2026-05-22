"""infra/xserver/docker-compose.yml の構成回帰テスト。

過去に `RESOLVER_BASE_URL: ${RESOLVER_BASE_URL:-http://resolver:8080}` と
変数展開していたため、VPS 上の .env に旧設定 (host.docker.internal や
外部 IP) が残っていると api コンテナへそのまま注入されてしまい、
docker network 内の resolver に到達できず DNS エラーで /resolve-mp4 が
502 を返す事故があった。

このテストでは api / jobs-worker の environment.RESOLVER_BASE_URL が
リテラル `http://resolver:8080` でハードコードされていることを確認する。
"""
from __future__ import annotations

from pathlib import Path

import pytest

# repo root を遡って解決する。apps/api/tests/test_infra_compose.py から見て 4 つ上。
_REPO_ROOT = Path(__file__).resolve().parents[3]
_COMPOSE = _REPO_ROOT / "infra" / "xserver" / "docker-compose.yml"


def _load_compose() -> dict:
    yaml = pytest.importorskip("yaml")
    with _COMPOSE.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


@pytest.mark.parametrize("service_name", ["api", "jobs-worker"])
def test_resolver_base_url_is_hardcoded(service_name: str) -> None:
    """api / jobs-worker は RESOLVER_BASE_URL=http://resolver:8080 でなければならない。

    `${RESOLVER_BASE_URL:-...}` 形式だと、ホスト側 .env に旧値が残っていた
    場合に展開結果がそちらになり、コンテナの DNS 解決に失敗する。
    """
    data = _load_compose()
    services = data.get("services", {})
    assert service_name in services, f"service {service_name!r} not found in compose"
    env = services[service_name].get("environment", {})
    # docker-compose は environment を dict / list のどちらでも書ける。
    if isinstance(env, list):
        env_map = {}
        for item in env:
            if "=" in item:
                k, v = item.split("=", 1)
                env_map[k] = v
            else:
                env_map[item] = None
    else:
        env_map = dict(env)

    value = env_map.get("RESOLVER_BASE_URL")
    assert value == "http://resolver:8080", (
        f"{service_name}.environment.RESOLVER_BASE_URL must be hardcoded to "
        f"'http://resolver:8080' (not a ${{VAR:-default}} interpolation) so "
        f"stale .env values cannot override it. got: {value!r}"
    )
