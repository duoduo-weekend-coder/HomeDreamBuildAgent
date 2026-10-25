"""Direct local Reel uploads with durable posting status; no demo publishing."""
import hashlib
import http.client
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path


class InstagramError(ValueError):
    pass


@dataclass(frozen=True)
class InstagramConfig:
    user_id: str
    token: str
    version: str = "v23.0"

    def validate(self):
        if not re.fullmatch(r"[0-9]+", self.user_id):
            raise InstagramError("Add the numeric Instagram professional account ID in Instagram settings.")
        if not self.token or any(c.isspace() or c in "\"'" for c in self.token):
            raise InstagramError("Add a valid Instagram access token in Instagram settings.")
        if not re.fullmatch(r"v[0-9]+\.0", self.version):
            raise InstagramError("The API version must look like v23.0.")
        return self


class InstagramClient:
    def __init__(self, config: InstagramConfig):
        self.config = config.validate()

    def call(self, method: str, path: str, **params) -> dict:
        url = f"https://graph.facebook.com/{self.config.version}/{path}"
        encoded = urllib.parse.urlencode(params).encode()
        if method == "GET" and params:
            url += "?" + encoded.decode()
        request = urllib.request.Request(url, method=method, data=encoded if method == "POST" else None,
            headers={"Authorization": f"Bearer {self.config.token}",
                     "Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                result = json.loads(response.read())
        except urllib.error.HTTPError as exc:
            try:
                error = json.loads(exc.read()).get("error", {})
                message = str(error.get("message", "Instagram rejected the request."))
                code = error.get("code")
            except (ValueError, AttributeError):
                message, code = "Instagram rejected the request.", None
            finally:
                exc.close()
            if code == 190:
                message += " Update the expired or invalid access token in Instagram settings."
            elif code in (10, 200):
                message += " Check instagram_basic, instagram_content_publish and pages_read_engagement permissions."
            raise InstagramError(message.replace(self.config.token, "[redacted]")[:600]) from None
        except (OSError, ValueError, http.client.HTTPException):
            raise InstagramError("Could not get a response from Instagram. Check your connection and account setup.") from None
        if not isinstance(result, dict) or "error" in result:
            raise InstagramError("Instagram returned an unexpected response.")
        return result

    def account(self) -> dict:
        account = self.call("GET", self.config.user_id, fields="id,username")
        if not account.get("id") or not account.get("username"):
            raise InstagramError("That token could not read the selected Instagram professional account.")
        return {"user_id": self.config.user_id, "username": str(account["username"])}

    def create_upload(self, caption: str) -> str:
        if len(caption) > 2200:
            raise InstagramError("Instagram captions must be 2,200 characters or fewer.")
        result = self.call("POST", f"{self.config.user_id}/media", media_type="REELS",
                           upload_type="resumable", caption=caption, share_to_feed="true")
        container = str(result.get("id", ""))
        if not re.fullmatch(r"[0-9]+", container):
            raise InstagramError("Instagram did not return a valid upload container ID.")
        return container

    def upload_video(self, container_id: str, video: Path) -> None:
        """Stream to Meta's fixed upload host; never follow a returned arbitrary upload URL.

        See Meta's /documentation/instagram-platform/content-publishing/resumable-uploads.
        This sends the whole file at offset zero; interrupted uploads are not auto-retried.
        """
        if not re.fullmatch(r"[0-9]+", container_id):
            raise InstagramError("Local upload requires a Facebook Login upload container.")
        connection = http.client.HTTPSConnection("rupload.facebook.com", timeout=120)
        try:
            with video.open("rb") as stream:
                size = video.stat().st_size
                if not size:
                    raise InstagramError("The selected video is empty.")
                connection.request("POST", f"/ig-api-upload/{self.config.version}/{container_id}", body=stream,
                    headers={"Authorization": f"OAuth {self.config.token}", "offset": "0", "file_size": str(size),
                             "Content-Length": str(size), "Content-Type": "application/octet-stream"})
                response = connection.getresponse()
                result = json.loads(response.read())
                if response.status >= 400 or not isinstance(result, dict) or result.get("success") is not True:
                    raise InstagramError("Meta rejected the video upload. Check the Page access token, publishing permissions and video format.")
        except InstagramError:
            raise
        except (OSError, ValueError, http.client.HTTPException):
            raise InstagramError("The video upload to Meta was interrupted. Nothing was published; try again.") from None
        finally:
            connection.close()

    def container_status(self, container_id: str) -> str:
        result = self.call("GET", container_id, fields="status_code,status")
        code = result.get("status_code")
        if code in ("ERROR", "EXPIRED"):
            raise InstagramError("Instagram could not process this video. Check that the video meets Reel requirements.")
        if code not in ("IN_PROGRESS", "FINISHED", "PUBLISHED"):
            raise InstagramError("Instagram returned an unexpected video processing status.")
        return code

    def publish(self, container_id: str) -> str:
        result = self.call("POST", f"{self.config.user_id}/media_publish", creation_id=container_id)
        if not result.get("id"):
            raise InstagramError("Instagram did not return a published media ID.")
        return str(result["id"])

    def permalink(self, media_id: str) -> str:
        value = self.call("GET", media_id, fields="permalink").get("permalink", "")
        url = urllib.parse.urlsplit(value)
        return value if url.scheme == "https" and url.hostname in ("www.instagram.com", "instagram.com") else ""


ACTIVE = {"queued", "creating", "uploading", "processing", "publishing"}
UNCERTAIN = "Posting was interrupted or Instagram did not confirm the result. Check the account before posting again; this attempt will not be sent again automatically."


def output_version(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_mtime_ns}:{stat.st_size}"


class InstagramPublisher:
    def __init__(self):
        self.lock = threading.RLock()
        self.records: dict[str, list[dict]] = {}

    def _load(self, folder: Path) -> list[dict]:
        key = str(folder)
        if key not in self.records:
            path = folder / "instagram-posts.json"
            records = json.loads(path.read_text()) if path.exists() else []
            for record in records:
                if record["status"] in ACTIVE:
                    record.update(status="unknown", error=UNCERTAIN)
            self.records[key] = records
            if records:
                self._save(folder)
        return self.records[key]

    def _save(self, folder: Path):
        path = folder / "instagram-posts.json"
        temp = folder / f".instagram-posts-{uuid.uuid4().hex}.tmp"
        try:
            temp.write_text(json.dumps(self.records[str(folder)], indent=2))
            temp.chmod(0o600)
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)

    def posts(self, folder: Path) -> list[dict]:
        with self.lock:
            return [dict(p) for p in self._load(folder)]

    def active(self, folder: Path) -> bool:
        return any(p["status"] in ACTIVE for p in self.posts(folder))

    def start(self, folder: Path, filename: str, version: str, caption: str, config: InstagramConfig) -> tuple[dict, bool]:
        config.validate()
        if not isinstance(caption, str) or len(caption) > 2200:
            raise InstagramError("Instagram captions must be 2,200 characters or fewer.")
        path = folder / "output" / filename
        if (Path(filename).name != filename or path.suffix.lower() != ".mp4"
                or not path.is_file() or path.is_symlink()
                or path.resolve().parent != (folder / "output").resolve()):
            raise InstagramError("Choose a finished MP4 from this job.")
        if output_version(path) != version:
            raise InstagramError("This video has changed. Refresh the page and review the new version before posting.")
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if output_version(path) != version:
            raise InstagramError("This video is being updated. Wait for rendering to finish.")
        with self.lock:
            records = self._load(folder)
            previous = next((p for p in reversed(records) if p["digest"] == digest
                             and p["user_id"] == config.user_id and p["status"] != "failed"), None)
            if previous:
                return dict(previous), False
            post = {"id": uuid.uuid4().hex, "filename": filename, "version": version,
                    "digest": digest, "user_id": config.user_id, "caption": caption,
                    "created": time.time(), "status": "queued", "error": ""}
            records.append(post)
            self._save(folder)  # reserve before starting any API call, including across restarts
            threading.Thread(target=self._run, args=(folder, post, config), daemon=True).start()
            return dict(post), True

    def _update(self, folder, post, **values):
        with self.lock:
            post.update(values, updated=time.time())
            self._save(folder)

    def _run(self, folder, post, config):
        try:
            client = InstagramClient(config)
            self._update(folder, post, status="creating")
            video = folder / "output" / post["filename"]
            if output_version(video) != post["version"]:
                raise InstagramError("The video changed before upload. Refresh and review it again.")
            container = client.create_upload(post["caption"])
            self._update(folder, post, status="uploading", container_id=container)
            client.upload_video(container, video)
            self._update(folder, post, status="processing", container_id=container)
            deadline = time.monotonic() + 600
            while True:
                status = client.container_status(container)
                if status == "FINISHED":
                    break
                if status == "PUBLISHED":
                    self._update(folder, post, status="unknown", error=UNCERTAIN)
                    return
                if time.monotonic() >= deadline:
                    raise InstagramError("Instagram is taking too long to process the video. Nothing was published; try again later.")
                time.sleep(5)
            self._update(folder, post, status="publishing")
            media_id = client.publish(container)
            # Save success before requesting the optional link. A link failure must never trigger a repost.
            self._update(folder, post, status="published", media_id=media_id, error="")
            try:
                link = client.permalink(media_id)
                self._update(folder, post, permalink=link)
            except (InstagramError, OSError):
                pass
        except Exception as exc:
            if post["status"] == "published":
                return
            uncertain = post["status"] == "publishing"
            message = str(exc) if isinstance(exc, InstagramError) else "Posting stopped because of a local error. Check the server and try again."
            self._update(folder, post, status="unknown" if uncertain else "failed",
                         error=UNCERTAIN if uncertain else message)
