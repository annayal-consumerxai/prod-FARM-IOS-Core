# Screen parser (optional like/save detection)

Doomscroll can ask a local icon-detection service where TikTok's like and save
buttons are on **every video**, and whether the video is already liked or saved.
Without it, the farm finds the heart and bookmark once at the start of a run
(template match) and reuses those points, or falls back to the coordinate
profile.

It is off unless `SCREEN_PARSER_URL` is set. If the service is down, slow or
unsure, doomscroll uses the old coordinates, so turning it on never blocks a run.

## What changes when it is on

For each video where the personality decides to like or save:

1. One screenshot is sent to `POST /v1/parse`.
2. If the heart is already filled (`tt_liked`), the like is skipped. Same for a
   filled bookmark (`tt_saved`). Tapping either would undo it.
3. Otherwise the detected icon is tapped once, at its detected centre.
4. The next frame is parsed again to confirm the icon turned filled.
5. If no icon is found above the confidence floor, the original tap is used
   (double-tap at the like point, single tap at the save point).

After three parser errors in a row, the run stops asking it and finishes on the
fallback coordinates.

The run summary adds a line like:

```
Screen parser: likes=14/14 confirmed, saves=5/5 confirmed, alreadyLiked=1, alreadySaved=0, fallbackLikes=0, fallbackSaves=0
```

Compare `confirmed` against the totals to measure accuracy on your phones.

## Run the service

The service is [advnt-screen-parser](https://github.com/arthuryeti/advnt-screen-parser)
(Python, CPU only, about 200 ms per frame). Pin a commit; the
version below is the one this integration was tested against.

With Docker:

```sh
git clone https://github.com/arthuryeti/advnt-screen-parser.git
cd advnt-screen-parser
git checkout c689a1491c50c653ff042cdec58866be6216b872
docker build -t screen-parser .
docker run -d --name screen-parser --restart unless-stopped -p 127.0.0.1:8000:8000 screen-parser
```

Without Docker (Python 3.10+):

```sh
pip install "advnt-screen-parser[all] @ git+https://github.com/arthuryeti/advnt-screen-parser.git@c689a1491c50c653ff042cdec58866be6216b872"
uvicorn advnt_screen_parser.server:app --host 127.0.0.1 --port 8000 --workers 1
```

Check it with `curl http://127.0.0.1:8000/health/ready`.

The model weights are AGPL-3.0. They run in their own process and are not
bundled with or linked into this repository.

## Configure the farm

Add to `.env`, then restart the worker:

```sh
SCREEN_PARSER_URL=http://127.0.0.1:8000
# Optional: matches ADVNT_API_TOKEN on the service.
# SCREEN_PARSER_TOKEN=
# Optional: per-request timeout (500-30000, default 5000).
# SCREEN_PARSER_TIMEOUT_MS=5000
# Optional: minimum icon confidence (0.01-0.99, default 0.35).
# SCREEN_PARSER_MIN_CONFIDENCE=0.35
```

At the start of a doomscroll the log says either
`Screen parser ready at … ; like/save are located on every video` or
`… is not ready; using fallback coordinates for this run`.

Keep the service bound to `127.0.0.1`. It receives full-screen screenshots of
the phones.
