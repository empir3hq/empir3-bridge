# Empir3 fleet media connector

Add an API custom provider, choose Image or Video, and select the
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
