from fastapi import APIRouter

from app.api.v1.endpoints.actresses import router as actresses_router
from app.api.v1.endpoints.auth import router as auth_router
from app.api.v1.endpoints.events import router as events_router
from app.api.v1.endpoints.feed import router as feed_router
from app.api.v1.endpoints.health import router as health_router
from app.api.v1.endpoints.home import router as home_router
from app.api.v1.endpoints.me import router as me_router
from app.api.v1.endpoints.movies import router as movies_router
from app.api.v1.endpoints.rankings import router as rankings_router
from app.api.v1.endpoints.search import router as search_router
from app.api.v1.endpoints.tags import router as tags_router

api_router = APIRouter()
api_router.include_router(health_router, tags=["health"])
api_router.include_router(feed_router, tags=["feed"])
api_router.include_router(movies_router, tags=["movies"])
api_router.include_router(search_router, tags=["search"])
api_router.include_router(tags_router, tags=["tags"])
api_router.include_router(events_router, tags=["events"])
api_router.include_router(rankings_router, tags=["rankings"])
api_router.include_router(home_router, tags=["home"])
api_router.include_router(auth_router, tags=["auth"])
api_router.include_router(me_router, tags=["me"])
api_router.include_router(actresses_router, tags=["actresses"])
