from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_read_movie_detail():
    response = client.get("/api/v1/movies/sample-movie-001")

    assert response.status_code == 200

    data = response.json()
    assert data["slug"] == "sample-movie-001"
    assert data["title"] == "サンプル作品 001"
    assert "affiliate_url" in data


def test_read_movie_detail_not_found():
    response = client.get("/api/v1/movies/not-found-slug")

    assert response.status_code == 404
    assert response.json() == {"detail": "Movie not found"}