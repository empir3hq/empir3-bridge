# Empir3 fleet media connector

Add an API custom provider, choose Image, Video or Music, and select the
`empir3-fleet` wire. Configure your gateway base URL, credential and exact
model list. A model must appear in the gateway's discovery response before
the Bridge advertises it as ready. Saving a provider does not assign any
plan or tool route.

Images use JSON generation and edit requests. Supply one inline PNG, JPEG
or WebP reference through `reference_image_base64` and `reference_mime_type`.
Explicit dimensions and aspect ratio are preserved. Unsupported options
fail before generation starts.

The current video profile accepts text input, 5 seconds, 1024x576 (576p),
16:9, 24 fps, with generated audio. References, quality presets and silent
video requests are refused before a job is created.

The Bridge submits one durable video job, polls the same authenticated job,
and downloads its MP4 content. It never retries submission or follows
artifact URLs supplied by the job response. Stopping a wait does not cancel
GPU work. The default wait is 45 minutes, capped at 2 hours; an explicit
shorter caller deadline takes precedence. The gateway retains its job and
artifact after the Bridge disconnects.

Music uses the queued song API (`POST /v1/music`, poll the same job every
5 seconds, then `GET /v1/music/{id}/content`). Choose Music in the provider
modal and the **Empir3 fleet (queued song jobs)** connection. The gateway
URL may include `/v1` or omit it. Test discovers only models advertising
`musicgen`; a configured model list restricts that catalog. Music defaults
to one concurrent request. The gateway credential remains on the Bridge.

Song input accepts `model`, `prompt` (1–2000 characters), `duration` (integer
10–600 seconds), optional `lyrics` (1–6000 characters), `instrumental`
(boolean), `bpm` (40–240), `quality` (`draft` or `final`), and a nonnegative
safe-integer `seed`, and `vocal_language` (a language code such as `en`).
Unknown fields are rejected before a job is submitted.
Omit lyrics or set `instrumental: true` for instrumental output.

Music has the same 45-minute default and 2-hour ceiling as fleet video;
shorter caller deadlines are honored. Stopping the wait does not cancel the
gateway's GPU job. Job identity and model must remain unchanged throughout
polling. The result must be `audio/wav` with RIFF/WAVE magic. Output is capped
at 128 MiB and also at the server's upload grant, which must allow the desired
song size (about 11.5 MB per minute, 115 MB for 600 seconds). Large songs use
the asset upload tier. Completion metadata exposes only `dit_model`,
`lm_model`, and `seed`, allowing the app to identify the backend models.
