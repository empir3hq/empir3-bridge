# Empir3 Bridge User Guide

This guide is for people using the Bridge console, not developers working on
the Bridge source code. It starts with the most common provider setup questions
and will grow as new user workflows are added.

## Add your own model provider

Empir3 Bridge can connect to an OpenAI-compatible service running:

- on the same computer, such as LM Studio or Ollama;
- on another computer reachable over a private LAN, VPN, or Tailscale;
- on a private inference server, such as vLLM;
- at a cloud provider that gives you an OpenAI-compatible address and API key.

Open **API & CLIs**, select **Add custom provider**, and complete the form.

| Field | What to enter |
| --- | --- |
| Provider name | A name you will recognize, such as `My local LM Studio` or `Office GPU server` |
| API address | The provider's OpenAI-compatible base address, normally ending in `/v1` |
| API key | Leave blank for a keyless local/private service; otherwise enter the provider's key |
| Models | Leave blank to ask `/v1/models`; enter comma-separated model IDs only when discovery is unavailable |
| Make this available to my Empir3 agents | Turn on only when you want this provider to appear under **My Bridge** in Empir3 |
| Slug (Advanced) | A short unique route name; do not reuse the slug of a platform or another Bridge provider |

Select **Add provider**. A successful setup shows **ONLINE** and the discovered
model count. If sharing is enabled, the provider and model names can appear in
Empir3, but the API address and API key remain on this computer.

### Example: self-hosted vLLM over Tailscale

Assume a model server is reachable from the Bridge computer at
`http://100.x.y.z:8000/v1` and advertises `my-model-id`.

| Field | Example value |
| --- | --- |
| Provider name | `My private GPU server` |
| API address | `http://100.x.y.z:8000/v1` |
| API key | blank, if the private server is keyless |
| Models | blank for automatic discovery, or `my-model-id` |
| Available to my Empir3 agents | on, if desired |
| Slug | `my-private-gpu` |

The Bridge computer must be signed into the same Tailscale network and able to
reach the model server. The Empir3 cloud does not need direct network access to
the server: inference requests run through the paired Bridge.

Keep a keyless HTTP endpoint private. Do not expose it directly to the public
internet. Public endpoints should use HTTPS and authentication.

## Common provider addresses

| Service | Typical API address | Key normally required? |
| --- | --- | --- |
| LM Studio on this computer | `http://127.0.0.1:1234/v1` | No |
| Ollama on this computer | `http://127.0.0.1:11434/v1` | No |
| vLLM on a private machine | `http://PRIVATE-IP:8000/v1` | Depends on its configuration |
| OpenAI-compatible cloud service | The `/v1` address supplied by the provider | Usually |

`localhost` and `127.0.0.1` always mean the computer running the Bridge. If the
model runs on a different computer, use an address that the Bridge computer can
actually reach.

## Test the provider

1. Confirm the provider row says **ONLINE**.
2. Confirm the expected model appears in the discovered model list.
3. Leave **Make this available to my Empir3 agents** on if you want to use it
   from Empir3.
4. In Empir3, open Agent Builder or **Account > Providers > My Bridge** and
   select the exact Bridge provider and model.
5. Send a short test message before assigning it a long or tool-heavy task.

A Bridge provider and a similarly named Empir3 platform provider are separate
routes. Give the Bridge provider a distinct name and slug so you can tell which
computer and billing path served the request.

## Build one agent from several computers

Install and pair Empir3 Bridge on every computer you want the agent to use.
Give each Bridge a recognizable device name, such as `Desktop`, `Laptop`, or
`GPU box`, so Agent Builder can show where an ability will run.

On each machine, open **API & CLIs** and choose **Add custom provider**:

| Agent ability | Provider kind | Common wire |
| --- | --- | --- |
| Brain | Chat / Brain | OpenAI-compatible chat endpoint |
| Ears | Speech-to-text / Ears | OpenAI transcriptions or Whisper HTTP |
| Mouth | Text-to-speech / Mouth | OpenAI speech or Kokoro native |
| Imagination | Image / Imagination | AUTOMATIC1111, ComfyUI, or OpenAI-compatible images |

Enter the endpoint and model details, test that the row shows **ONLINE**, then
turn on **Make this available to my Empir3 agents**. Repeat only for the
abilities that machine is willing to lend. Endpoint addresses, API keys, and
ComfyUI workflow JSON stay on that computer; Empir3 receives safe routing
metadata and sends the work through the paired Bridge.

Open Agent Builder in Empir3 and select a device under Brain, Ears, Mouth, or
Imagination. A specific device is a strict pin. If it goes offline, the request
stops and names that machine; Empir3 does not spend on a cloud fallback. **Any
of my machines** appears when at least two online devices advertise the same
provider slug, kind, and model. That setting can move a request among those
matching machines as availability changes.

Small voice/image results travel inline. Larger images and existing
Higgsfield/Agy media use a short-lived, single-use upload grant automatically;
there is no separate user upload step.

## Questions and answers

### Why does the provider show offline?

The Bridge computer could not reach the API address or the provider rejected
the request. Check that the model server is running, the address ends in the
correct `/v1` path, the LAN/VPN/Tailscale connection is active, and any required
key is correct. From the Bridge computer, the provider's `/v1/models` endpoint
should return a model list.

### Why were no models discovered?

Some compatible services do not implement `/v1/models`, or they require a key
for discovery. Enter the exact model ID in **Models**. The value must match what
the provider expects in a chat-completion request.

### Do local providers need an API key?

Not always. LM Studio, Ollama, and private vLLM installations are often
keyless. A service reachable from the public internet should use HTTPS and
authentication even if its software makes the key optional.

### Does Empir3 receive my provider address or API key?

No. The address and key stay in the Bridge's protected local settings. When you
enable sharing, Empir3 receives safe routing information such as the provider
name, available model IDs, device identity, and health. Requests assigned to
that route execute through the paired Bridge.

### What does “Make this available to my Empir3 agents” do?

It advertises the provider's safe metadata to your own Empir3 account so the
provider can appear under **My Bridge**. Turning it off keeps the provider local
to Bridge clients such as MCP.

### Will a Bridge update remove my providers or keys?

Normal updates retain Bridge data outside the application installation folder.
Provider and key settings use atomic writes and last-known-good backups. A
damaged primary settings file can be recovered from its backup instead of being
silently replaced with empty defaults.

### Who pays for a Bridge-provider request?

The request uses the hardware, API account, or subscription behind that Bridge
route. Empir3 labels user-owned local text inference separately from paid
platform inference. Voice, image, video, and other services can still have
their own configured costs.

### Can I add a provider that already exists in Empir3's platform catalog?

Yes. The platform route and your Bridge route are independent. Use a distinct
provider name and slug, then select the Bridge route explicitly under **My
Bridge** when you want the request to use your computer or provider account.

## Information to include when asking for help

Share the following without sending an API key:

- Bridge version;
- operating system;
- provider name and API address with private host details redacted if needed;
- whether the provider row says online or offline;
- expected model ID and discovered model IDs;
- whether the service is on the same computer, LAN, VPN/Tailscale, or internet;
- the exact error shown by the Bridge.
