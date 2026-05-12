from fastapi import FastAPI

from app.api.v1.api import api_router

app = FastAPI(
    title="Short Video Media API",
    version="0.1.0",
)

app.include_router(api_router, prefix="/api/v1")


@app.get("/")
def root():
    return {"message": "Short Video Media API"}