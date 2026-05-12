from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_read_feed_returns_items():
    response = client.get("/api/v1/feed")

    assert response.status_code == 200

    data = response.json()
    assert "items" in data
    assert "next_cursor" in data
    assert isinstance(data["items"], list)
    assert len(data["items"]) > 0
    assert data["next_cursor"] is None


def test_read_feed_item_has_required_fields():
    response = client.get("/api/v1/feed")

    assert response.status_code == 200

    data = response.json()
    first_item = data["items"][0]

    assert "id" in first_item
    assert "title" in first_item
    assert "slug" in first_item
    assert "thumbnail_url" in first_item
    assert "sample_embed_url" in first_item
    assert "actresses" in first_item
    assert "genres" in first_item

    assert isinstance(first_item["id"], str)
    assert isinstance(first_item["title"], str)
    assert isinstance(first_item["slug"], str)
    assert isinstance(first_item["thumbnail_url"], str)
    assert isinstance(first_item["sample_embed_url"], str)
    assert isinstance(first_item["actresses"], list)
    assert isinstance(first_item["genres"], list)


def test_read_feed_first_item_expected_values():
    response = client.get("/api/v1/feed")

    assert response.status_code == 200

    data = response.json()
    first_item = data["items"][0]

    assert first_item["id"] == "movie-001"
    assert first_item["title"] == "サンプル作品 001"
    assert first_item["slug"] == "sample-movie-001"