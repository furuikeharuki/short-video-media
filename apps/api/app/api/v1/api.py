from fastapi import APIRouter

from app.api.v1.endpoints.feed import router as feed_router
from app.api.v1.endpoints.health import router as health_router
from app.api.v1.endpoints.movies import router as movies_router
from app.api.v1.endpoints.tags import router as tags_router

api_router = APIRouter()
api_router.include_router(health_router, tags=["health"])
api_router.include_router(feed_router, tags=["feed"])
api_router.include_router(movies_router, tags=["movies"])
api_router.include_router(tags_router, tags=["tags"])
