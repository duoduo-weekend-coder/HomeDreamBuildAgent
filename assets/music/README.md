# Music

Tracks live here but are not committed (see `.gitignore`): they are licensed for use in videos, not for redistribution.
To set up a machine, copy the tracks in and rebuild the library:

```bash
python3 .claude/skills/home-video/scripts/music_library.py ~/Downloads/songlib --into assets/music
```

`library.json` / `library.md` record each track's tempo, tone, energy, which templates it suits, its license, and the best
excerpt start for each template and length. The renderer uses those starts automatically.
