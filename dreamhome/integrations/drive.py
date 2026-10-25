"""Google Drive ingest. Folder convention: <root>/<project>/<YYYY-MM-DD>/{images..., notes.txt}.
A local directory with the same layout works too (used for offline dev and tests)."""
import io
from dataclasses import dataclass, field
from pathlib import Path

from dreamhome.config import CACHE_DIR, get_settings
from dreamhome.integrations.google_auth import credentials

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic"}
FOLDER_MIME = "application/vnd.google-apps.folder"


@dataclass
class Batch:
    project: str
    date: str
    images: list[Path] = field(default_factory=list)
    notes: str = ""
    source_ids: list[str] = field(default_factory=list)


def load_local_batch(folder: Path) -> Batch:
    folder = Path(folder)
    images = sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXT)
    notes_file = folder / "notes.txt"
    return Batch(
        project=folder.parent.name,
        date=folder.name,
        images=images,
        notes=notes_file.read_text().strip() if notes_file.exists() else "",
        source_ids=[str(p) for p in images],
    )


def _service():
    from googleapiclient.discovery import build

    creds = credentials()
    if creds is None:
        raise RuntimeError("Google credentials not configured (see README: Google setup)")
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _children(svc, parent_id: str, folders: bool | None = None) -> list[dict]:
    q = f"'{parent_id}' in parents and trashed = false"
    if folders is True:
        q += f" and mimeType = '{FOLDER_MIME}'"
    elif folders is False:
        q += f" and mimeType != '{FOLDER_MIME}'"
    out, token = [], None
    while True:
        resp = svc.files().list(q=q, fields="nextPageToken, files(id, name, mimeType)", pageToken=token, pageSize=1000).execute()
        out += resp.get("files", [])
        token = resp.get("nextPageToken")
        if not token:
            return sorted(out, key=lambda f: f["name"])


def list_drive_batches(project: str | None = None) -> list[tuple[str, str, str]]:
    """Return (project, date, folder_id) for every dated folder under the root."""
    svc = _service()
    root = get_settings().google_drive_root_folder_id
    result = []
    for proj in _children(svc, root, folders=True):
        if project and proj["name"] != project:
            continue
        for day in _children(svc, proj["id"], folders=True):
            result.append((proj["name"], day["name"], day["id"]))
    return result


def download_drive_batch(project: str, date: str, folder_id: str, skip_ids: set[str] = frozenset()) -> Batch:
    from googleapiclient.http import MediaIoBaseDownload

    svc = _service()
    dest = CACHE_DIR / project / date
    dest.mkdir(parents=True, exist_ok=True)
    batch = Batch(project=project, date=date)
    for f in _children(svc, folder_id, folders=False):
        name, ext = f["name"], Path(f["name"]).suffix.lower()
        if name.lower() == "notes.txt":
            batch.notes = svc.files().get_media(fileId=f["id"]).execute().decode("utf-8", "ignore").strip()
            continue
        if ext not in IMAGE_EXT or f["id"] in skip_ids:
            continue
        path = dest / name
        if not path.exists():
            buf = io.BytesIO()
            downloader = MediaIoBaseDownload(buf, svc.files().get_media(fileId=f["id"]))
            done = False
            while not done:
                _, done = downloader.next_chunk()
            path.write_bytes(buf.getvalue())
        batch.images.append(path)
        batch.source_ids.append(f["id"])
    return batch
