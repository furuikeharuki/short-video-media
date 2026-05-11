from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_feed_and_detail_are_consistent_for_first_item():
    feed_response = client.get("/api/v1/feed")
    assert feed_response.status_code == 200

    feed_data = feed_response.json()
    assert len(feed_data["items"]) > 0

    first_item = feed_data["items"][0]
    slug = first_item["slug"]

    detail_response = client.get(f"/api/v1/movies/{slug}")
    assert detail_response.status_code == 200

    detail_data = detail_response.json()

    assert detail_data["id"] == first_item["id"]
    assert detail_data["title"] == first_item["title"]
    assert detail_data["slug"] == first_item["slug"]
    assert detail_data["thumbnail_url"] == first_item["thumbnail_url"]
    assert detail_data["sample_embed_url"] == first_item["sample_embed_url"]
    assert detail_data["actresses"] == first_item["actresses"]
    assert detail_data["genres"] == first_item["genres"]


def test_every_feed_slug_resolves_to_movie_detail():
    feed_response = client.get("/api/v1/feed")
    assert feed_response.status_code == 200

    feed_data = feed_response.json()

    for item in feed_data["items"]:
        detail_response = client.get(f"/api/v1/movies/{item['slug']}")
        assert detail_response.status_code == 200

        detail_data = detail_response.json()
        assert detail_data["slug"] == item["slug"]