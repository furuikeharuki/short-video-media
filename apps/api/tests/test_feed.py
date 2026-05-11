from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_read_feed():
    response = client.get("/api/v1/feed")

    assert response.status_code == 200

    data = response.json()
    assert "items" in data
    assert isinstance(data["items"], list)
    assert len(data["items"]) > 0
    assert data["items"][0]["id"] == "movie-001"
    assert data["next_cursor"] is None