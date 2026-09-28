"""Turn Bell: registers the desktop half and its ntfy backend routes.

The desktop UI lives in ~/.hermes/desktop-plugins/turn-bell/plugin.js; this package
only carries the dashboard API the UI calls (/api/plugins/turn-bell/status|notify).
"""


def register(ctx) -> None:
    return None
