import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()

DEFAULT_SERVER = "https://ntfy.sh"
MAX_MESSAGE = 4096
ECHO_TAG = "hermes-agent"
MARKDOWN_TRUTHY = ("1", "true", "yes")
HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


class NotifyRequest(BaseModel):
    title: str = ""
    message: str = ""
    priority: str = "default"
    tags: list[str] = Field(default_factory=list)


def _read_yaml(path: Path) -> dict:
    try:
        import yaml

        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _dotenv() -> dict:
    values: dict[str, str] = {}
    try:
        text = (HERMES_HOME / ".env").read_text(encoding="utf-8")
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _config_extra() -> dict:
    platforms = _read_yaml(HERMES_HOME / "config.yaml").get("platforms")
    if not isinstance(platforms, dict):
        return {}
    ntfy = platforms.get("ntfy")
    if not isinstance(ntfy, dict):
        return {}
    extra = ntfy.get("extra")
    return extra if isinstance(extra, dict) else {}


def _client_yml() -> dict:
    return _read_yaml(Path.home() / ".config" / "ntfy" / "client.yml")


def _text(value) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def resolve() -> dict:
    extra = _config_extra()
    env = {**_dotenv(), **{k: v for k, v in os.environ.items() if k.startswith("NTFY")}}
    client = _client_yml()

    def pick(extra_key: str, env_key: str) -> str:
        return _text(extra.get(extra_key)) or _text(env.get(env_key))

    topic = (
        pick("publish_topic", "NTFY_PUBLISH_TOPIC")
        or pick("topic", "NTFY_TOPIC")
        or pick("topic", "NTFY_HOME_CHANNEL")
        or _text(client.get("default-topic"))
    )
    server = pick("server", "NTFY_SERVER_URL") or _text(client.get("default-host")) or DEFAULT_SERVER
    token = pick("token", "NTFY_TOKEN")
    source = "config" if _text(extra.get("topic")) or _text(extra.get("publish_topic")) else "env"
    if not token:
        user = _text(client.get("default-user"))
        password = _text(client.get("default-password"))
        if user and password:
            token = f"{user}:{password}"
            if source == "env" and not _text(env.get("NTFY_TOPIC")):
                source = "client.yml"
    markdown = bool(extra.get("markdown")) or _text(env.get("NTFY_MARKDOWN")).lower() in MARKDOWN_TRUTHY
    if not topic:
        return {"ok": False, "error": "no ntfy topic configured in config.yaml, .env or client.yml", "source": ""}
    return {
        "ok": True,
        "topic": topic,
        "server": server.rstrip("/"),
        "token": token,
        "markdown": markdown,
        "source": source,
    }


def _auth_header(token: str) -> dict:
    if not token:
        return {}
    if ":" in token:
        return {"Authorization": f"Basic {base64.b64encode(token.encode()).decode()}"}
    return {"Authorization": f"Bearer {token}"}


def _priority(value) -> int:
    words = {"min": 1, "low": 2, "default": 3, "normal": 3, "high": 4, "urgent": 5, "max": 5}
    if isinstance(value, int) and not isinstance(value, bool):
        return min(max(value, 1), 5)
    return words.get(str(value or "").strip().lower(), 3)


def _publish(title: str, message: str, priority: str, tags: list, markdown: bool) -> dict:
    config = resolve()
    if not config["ok"]:
        return config
    headers = {"Content-Type": "application/json", **_auth_header(config["token"])}
    published = [tag for tag in tags if isinstance(tag, str) and tag][:9]
    if ECHO_TAG not in published:
        published.append(ECHO_TAG)
    document = {
        "topic": config["topic"],
        "title": title[:250],
        "message": message[:MAX_MESSAGE],
        "priority": _priority(priority),
        "tags": published,
    }
    if markdown:
        document["markdown"] = True
    body = json.dumps(document).encode("utf-8")
    request = urllib.request.Request(f"{config['server']}/", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:200]
        return {"ok": False, "error": f"ntfy HTTP {error.code}: {detail}", "topic": config["topic"]}
    except Exception as error:
        return {"ok": False, "error": f"ntfy publish failed: {error}", "topic": config["topic"]}
    return {
        "ok": True,
        "topic": config["topic"],
        "server": config["server"],
        "id": payload.get("id", ""),
        "markdown": config["markdown"],
    }


@router.get("/status")
def status() -> dict:
    config = resolve()
    if not config["ok"]:
        return config
    return {
        "ok": True,
        "topic": config["topic"],
        "server": config["server"],
        "auth": "token" if config["token"] and ":" not in config["token"] else ("basic" if config["token"] else "none"),
        "source": config["source"],
        "markdown": config["markdown"],
    }


@router.post("/notify")
def notify(request: NotifyRequest) -> dict:
    return _publish(request.title, request.message, request.priority, request.tags, resolve().get("markdown", False))
