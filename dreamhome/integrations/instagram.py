"""Instagram Graph API (Instagram API with Instagram Login, graph.instagram.com).
Without IG_ACCESS_TOKEN every call is logged and returns a fake id so the pipeline is demoable."""
import hashlib
import hmac
import logging
import time
import uuid

import httpx

from dreamhome.config import get_settings

log = logging.getLogger(__name__)


class InstagramError(RuntimeError):
    pass


def _enabled() -> bool:
    s = get_settings()
    return bool(s.ig_access_token and s.ig_user_id)


def _url(path: str) -> str:
    return f"https://graph.instagram.com/{get_settings().graph_api_version}/{path.lstrip('/')}"


def _call(method: str, path: str, **kwargs) -> dict:
    params = kwargs.pop("params", {})
    params["access_token"] = get_settings().ig_access_token
    r = httpx.request(method, _url(path), params=params, timeout=60, **kwargs)
    if r.status_code >= 400:
        raise InstagramError(f"{method} {path} -> {r.status_code}: {r.text}")
    return r.json()


def publish_reel(video_url: str, caption: str, poll_seconds: int = 5, timeout: int = 600) -> dict:
    """Create a REELS container from a public video URL, wait until processed, then publish."""
    if not _enabled():
        log.warning("[IG mock] publish reel %s", video_url)
        return {"id": f"mock_{uuid.uuid4().hex[:10]}", "permalink": ""}
    uid = get_settings().ig_user_id
    container = _call("POST", f"{uid}/media", params={
        "media_type": "REELS", "video_url": video_url, "caption": caption, "share_to_feed": "true",
    })["id"]
    deadline = time.time() + timeout
    while True:
        status = _call("GET", container, params={"fields": "status_code,status"})
        code = status.get("status_code")
        if code == "FINISHED":
            break
        if code in ("ERROR", "EXPIRED"):
            raise InstagramError(f"container {container} failed: {status}")
        if time.time() > deadline:
            raise InstagramError(f"container {container} timed out: {status}")
        time.sleep(poll_seconds)
    media_id = _call("POST", f"{uid}/media_publish", params={"creation_id": container})["id"]
    permalink = _call("GET", media_id, params={"fields": "permalink"}).get("permalink", "")
    return {"id": media_id, "permalink": permalink}


def send_dm(recipient_id: str, text: str) -> dict:
    if not _enabled():
        log.warning("[IG mock] DM to %s: %s", recipient_id, text)
        return {"message_id": "mock"}
    return _call("POST", f"{get_settings().ig_user_id}/messages",
                 json={"recipient": {"id": recipient_id}, "message": {"text": text}})


def private_reply(comment_id: str, text: str) -> dict:
    """Open a DM thread with the author of a comment (allowed once per comment, within 7 days)."""
    if not _enabled():
        log.warning("[IG mock] private reply to comment %s: %s", comment_id, text)
        return {"message_id": "mock"}
    return _call("POST", f"{get_settings().ig_user_id}/messages",
                 json={"recipient": {"comment_id": comment_id}, "message": {"text": text}})


def reply_to_comment(comment_id: str, text: str) -> dict:
    if not _enabled():
        log.warning("[IG mock] public reply to %s: %s", comment_id, text)
        return {"id": "mock"}
    return _call("POST", f"{comment_id}/replies", params={"message": text})


def verify_signature(body: bytes, header: str | None, secret: str | None = None) -> bool:
    secret = secret if secret is not None else get_settings().ig_app_secret
    if not secret:
        return True  # signature checking disabled in local dev
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header.removeprefix("sha256="))
