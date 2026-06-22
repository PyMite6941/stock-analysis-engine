import logging
import os
import time
from collections import defaultdict

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("stock-engine")

API_KEY = os.environ.get("API_KEY")

RATE_LIMIT_WINDOW = 60
RATE_LIMIT_MAX = 60
_hits = defaultdict(list)

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


class SecurityAndAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not path.startswith("/api/"):
            return await call_next(request)

        client_ip = request.client.host if request.client else "unknown"

        # Rate limiting
        now = time.time()
        window = _hits[client_ip]
        _hits[client_ip] = [t for t in window if now - t < RATE_LIMIT_WINDOW]
        if len(_hits[client_ip]) >= RATE_LIMIT_MAX:
            logger.warning("rate-limit exceeded ip=%s", client_ip)
            return Response(status_code=429, content='{"detail":"Too many requests"}',
                            media_type="application/json")
        _hits[client_ip].append(now)

        # Auth check — supports Bearer header or ?api_key= query param (for downloads)
        if API_KEY and request.method != "OPTIONS":
            auth = request.headers.get("Authorization", "")
            query_key = request.query_params.get("api_key", "")
            valid = (auth.startswith("Bearer ") and auth.split(" ", 1)[1] == API_KEY) or query_key == API_KEY
            if not valid:
                return Response(status_code=401,
                                content='{"detail":"Missing or invalid API key"}',
                                media_type="application/json",
                                headers={"WWW-Authenticate": "Bearer"})

        response = await call_next(request)

        for header, value in SECURITY_HEADERS.items():
            response.headers[header] = value

        logger.info("%s %s -> %s", request.method, path, response.status_code)
        return response
