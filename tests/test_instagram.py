"""Publishing tests use temporary jobs, fake credentials and mocked Meta responses."""
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

from app import server
from app.instagram import InstagramPublisher, output_version, InstagramClient, InstagramConfig, InstagramError

CONFIG = InstagramConfig("123456", "test-token-not-a-real-credential")
LOCAL_CONFIG = CONFIG


class InstagramClientTests(unittest.TestCase):
    def test_requires_credentials_instead_of_mock_success(self):
        with self.assertRaises(InstagramError):
            InstagramClient(InstagramConfig("", ""))


    @patch("urllib.request.urlopen")
    def test_token_in_header_and_url_encoded_caption(self, opening):
        opening.return_value.__enter__.return_value.read.return_value = b'{"id":"998877"}'
        client = InstagramClient(CONFIG)
        self.assertEqual(client.create_upload("Home & garden #build"), "998877")
        request = opening.call_args.args[0]
        self.assertNotIn(CONFIG.token, request.full_url)
        self.assertNotIn(CONFIG.token.encode(), request.data)
        self.assertEqual(request.get_header("Authorization"), "Bearer " + CONFIG.token)
        self.assertIn(b"caption=Home+%26+garden+%23build", request.data)
        self.assertIn(b"media_type=REELS", request.data)

    @patch("urllib.request.urlopen")
    def test_api_error_is_actionable_and_redacted(self, opening):
        body = json.dumps({"error": {"code": 190, "message": "Invalid token " + CONFIG.token}}).encode()
        opening.side_effect = urllib.error.HTTPError("https://graph.instagram.com/", 400, "Bad request", {}, io.BytesIO(body))
        with self.assertRaises(InstagramError) as caught:
            InstagramClient(CONFIG).account()
        self.assertNotIn(CONFIG.token, str(caught.exception))
        self.assertIn("expired or invalid", str(caught.exception))

    def test_caption_limit(self):
        with patch.object(InstagramClient, "call") as call:
            with self.assertRaises(InstagramError):
                InstagramClient(CONFIG).create_upload("x" * 2201)
            call.assert_not_called()

    @patch("urllib.request.urlopen")
    def test_local_upload_container_uses_facebook_api(self, opening):
        opening.return_value.__enter__.return_value.read.return_value = b'{"id":"998877"}'
        client = InstagramClient(LOCAL_CONFIG)
        self.assertEqual(client.create_upload("Local reel"), "998877")
        request = opening.call_args.args[0]
        self.assertTrue(request.full_url.startswith("https://graph.facebook.com/"))
        self.assertIn(b"upload_type=resumable", request.data)
        self.assertNotIn(b"video_url", request.data)

    @patch("app.instagram.http.client.HTTPSConnection")
    def test_local_file_is_streamed_to_meta_with_correct_headers(self, connection_class):
        with tempfile.TemporaryDirectory() as folder:
            video = Path(folder) / "test.mp4"
            video.write_bytes(b"local video bytes")
            connection = connection_class.return_value
            connection.getresponse.return_value.status = 200
            connection.getresponse.return_value.read.return_value = b'{"success":true}'
            sent = []
            connection.request.side_effect = lambda *args, **kwargs: sent.append(kwargs["body"].read())
            InstagramClient(LOCAL_CONFIG).upload_video("998877", video)
            connection_class.assert_called_once_with("rupload.facebook.com", timeout=120)
            self.assertEqual(sent, [b"local video bytes"])
            args, kwargs = connection.request.call_args
            self.assertEqual(args, ("POST", "/ig-api-upload/v23.0/998877"))
            self.assertEqual(kwargs["headers"]["Authorization"], "OAuth " + CONFIG.token)
            self.assertEqual(kwargs["headers"]["offset"], "0")
            self.assertEqual(kwargs["headers"]["Content-Length"], str(video.stat().st_size))
            connection.close.assert_called_once()

class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        (self.folder / "output").mkdir()
        self.video = self.folder / "output/reel.mp4"
        self.video.write_bytes(b"fake video fixture")
        self.publisher = InstagramPublisher()

    def start(self, **changes):
        values = dict(folder=self.folder, filename="reel.mp4", version=output_version(self.video),
                      caption="A home worth building.", config=CONFIG)
        values.update(changes)
        with patch("app.instagram.threading.Thread"):
            return self.publisher.start(**values)

    def run_post(self, client):
        self.start()
        record = self.publisher.records[str(self.folder)][-1]
        with patch("app.instagram.InstagramClient", return_value=client), patch("app.instagram.time.sleep"):
            self.publisher._run(self.folder, record, CONFIG)
        return self.publisher.posts(self.folder)[-1]

    def test_rejects_paths_symlinks_and_changed_video(self):
        for name in ("../reel.mp4", "/tmp/reel.mp4", "missing.mp4"):
            with self.subTest(name=name), self.assertRaises(InstagramError):
                self.start(filename=name)
        (self.folder / "output/link.mp4").symlink_to(self.video)
        with self.assertRaises(InstagramError):
            self.start(filename="link.mp4")
        with self.assertRaisesRegex(InstagramError, "changed"):
            self.start(version="old-version")

    def test_duplicate_clicks_and_caption_edits_reuse_attempt(self):
        first, started = self.start()
        second, repeated = self.start(caption="A different caption")
        self.assertTrue(started)
        self.assertFalse(repeated)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.publisher.posts(self.folder)), 1)

    def test_concurrent_requests_create_one_attempt(self):
        # Concurrent API handlers serialize at the reservation lock. Use real caller threads
        # and a fake publisher worker to exercise that lock without making API requests.
        with patch.object(self.publisher, "_run"):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: self.publisher.start(self.folder, "reel.mp4",
                    output_version(self.video), "Caption", CONFIG), range(2)))
        self.assertEqual(sum(started for _, started in results), 1)

    def test_success_waits_then_publishes_once(self):
        client = Mock()
        client.create_upload.return_value = "container-1"
        client.container_status.side_effect = ["IN_PROGRESS", "FINISHED"]
        client.publish.return_value = "media-1"
        client.permalink.return_value = "https://www.instagram.com/reel/example/"
        result = self.run_post(client)
        self.assertEqual(result["status"], "published")
        self.assertEqual(result["media_id"], "media-1")
        client.publish.assert_called_once_with("container-1")
        self.assertEqual(InstagramPublisher().posts(self.folder)[0]["status"], "published")
        saved = (self.folder / "instagram-posts.json").read_text()
        self.assertNotIn(CONFIG.token, saved)

    def test_failed_processing_never_publishes_and_can_retry(self):
        client = Mock()
        client.create_upload.return_value = "container-1"
        client.container_status.side_effect = InstagramError("Video unavailable")
        self.assertEqual(self.run_post(client)["status"], "failed")
        client.publish.assert_not_called()
        _, started = self.start()
        self.assertTrue(started)

    def test_missing_permalink_does_not_repeat_successful_post(self):
        client = Mock()
        client.create_upload.return_value = "container-1"
        client.container_status.return_value = "FINISHED"
        client.publish.return_value = "media-1"
        client.permalink.side_effect = InstagramError("Link lookup failed")
        self.assertEqual(self.run_post(client)["status"], "published")
        _, started = self.start()
        self.assertFalse(started)

    def test_lost_publish_response_blocks_retry(self):
        client = Mock()
        client.create_upload.return_value = "container-1"
        client.container_status.return_value = "FINISHED"
        client.publish.side_effect = InstagramError("Connection lost")
        result = self.run_post(client)
        self.assertEqual(result["status"], "unknown")
        self.assertIn("Check the account", result["error"])
        _, started = self.start()
        self.assertFalse(started)

    def test_restart_does_not_replay_pending_post(self):
        self.start()
        restarted = InstagramPublisher()
        self.assertEqual(restarted.posts(self.folder)[0]["status"], "unknown")
        self.publisher = restarted
        _, started = self.start()
        self.assertFalse(started)

    def test_local_publish_needs_no_url_and_uploads_before_publishing(self):
        self.start(config=LOCAL_CONFIG)
        record = self.publisher.records[str(self.folder)][-1]
        client = Mock()
        client.create_upload.return_value = "998877"
        client.container_status.return_value = "FINISHED"
        client.publish.return_value = "media-1"
        client.permalink.return_value = ""
        with patch("app.instagram.InstagramClient", return_value=client):
            self.publisher._run(self.folder, record, LOCAL_CONFIG)
        self.assertEqual(record["status"], "published")
        self.assertEqual([c[0] for c in client.mock_calls], ["create_upload", "upload_video", "container_status", "publish", "permalink"])
        client.upload_video.assert_called_once_with("998877", self.video)

    def test_local_upload_failure_never_publishes(self):
        self.start(config=LOCAL_CONFIG)
        record = self.publisher.records[str(self.folder)][-1]
        client = Mock()
        client.create_upload.return_value = "998877"
        client.upload_video.side_effect = InstagramError("Upload interrupted")
        with patch("app.instagram.InstagramClient", return_value=client):
            self.publisher._run(self.folder, record, LOCAL_CONFIG)
        self.assertEqual(record["status"], "failed")
        client.publish.assert_not_called()


class InstagramHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = Path(self.temp.name) / ".env"
        self.env.write_text("ELEVENLABS_API_KEY=fixture-existing-key\n")
        self.patch_env = patch.object(server, "ENV_FILE", self.env)
        self.patch_env.start()
        self.addCleanup(self.patch_env.stop)
        self.os_env = patch.dict(os.environ, {"IG_STUDIO_USER_ID": "", "IG_STUDIO_PAGE_ACCESS_TOKEN": ""})
        self.os_env.start()
        self.addCleanup(self.os_env.stop)
        self.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.http.server_port)
        self.addCleanup(self.stop_http)

    def stop_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    def request(self, body=None, origin=None, path="/api/instagram/settings"):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        request = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, json.loads(response.read())

    def test_settings_never_expose_token_and_preserve_other_keys(self):
        with patch.object(server.InstagramClient, "account", return_value={"user_id": CONFIG.user_id, "username": "homebuilder"}):
            status, data = self.request({"user_id": CONFIG.user_id, "access_token": CONFIG.token, "api_version": CONFIG.version})
        self.assertEqual(status, 200)
        self.assertTrue(data["configured"])
        self.assertNotIn(CONFIG.token, json.dumps(data))
        _, read_back = self.request()
        self.assertNotIn(CONFIG.token, json.dumps(read_back))
        self.assertIn("ELEVENLABS_API_KEY=fixture-existing-key", self.env.read_text())
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o600)

    def test_invalid_settings_do_not_overwrite_saved_credentials(self):
        with patch.object(server.InstagramClient, "account", side_effect=InstagramError("Expired token")):
            status, data = self.request({"user_id": CONFIG.user_id, "access_token": CONFIG.token})
        self.assertEqual(status, 400)
        self.assertEqual(data["error"], "Expired token")
        self.assertNotIn("IG_STUDIO_PAGE_ACCESS_TOKEN", self.env.read_text())

    def test_cross_origin_settings_are_rejected(self):
        status, _ = self.request({"user_id": CONFIG.user_id, "access_token": CONFIG.token}, "https://unrelated.example")
        self.assertEqual(status, 403)

    def test_bad_body_is_a_json_error(self):
        status, _ = self.request(["not an object"])
        self.assertEqual(status, 400)

    def test_unfinished_job_cannot_publish(self):
        job = server.Job("test", {})
        with patch.dict(server.jobs, {"test": job}):
            status, data = self.request({"filename": "reel.mp4"}, path="/api/jobs/test/instagram")
        self.assertEqual(status, 409)
        self.assertIn("finish", data["error"])


    def test_local_publish_endpoint_accepts_selected_output_without_public_url(self):
        self.env.write_text(f"IG_STUDIO_USER_ID={CONFIG.user_id}\nIG_STUDIO_PAGE_ACCESS_TOKEN={CONFIG.token}\n")
        job = server.Job("test", {})
        job.dir = Path(self.temp.name) / "job"
        (job.dir / "output").mkdir(parents=True)
        video = job.dir / "output/reel.mp4"
        video.write_bytes(b"test output")
        job.status = "done"
        with patch.dict(server.jobs, {"test": job}), patch.object(server, "instagram", InstagramPublisher()), patch.object(InstagramPublisher, "_run"):
            status, data = self.request({"filename": video.name, "version": output_version(video),
                "user_id": CONFIG.user_id, "caption": "Test reel"}, path="/api/jobs/test/instagram")
            self.assertEqual(status, 202)
            self.assertEqual(data["status"], "queued")
            self.assertNotIn(CONFIG.token, json.dumps(data))

    def test_changed_account_is_not_published(self):
        self.env.write_text(f"IG_STUDIO_USER_ID={CONFIG.user_id}\nIG_STUDIO_PAGE_ACCESS_TOKEN={CONFIG.token}\n")
        job = server.Job("test", {})
        job.status = "done"
        with patch.dict(server.jobs, {"test": job}), patch.object(server.instagram, "start") as start:
            status, _ = self.request({"user_id": "654321"}, path="/api/jobs/test/instagram")
            self.assertEqual(status, 409)
            start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
