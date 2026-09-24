"""Small standard-library bridge for a local AI client on the Tailscale network.

Set CANVAS_API_TOKEN in the local process environment. An AI can call
get_canvas(), decide which supported actions to take, then call apply_actions().
"""

import json
import os
import sys
from urllib.request import Request, urlopen

BASE_URL = os.environ.get("CANVAS_BASE_URL", "http://127.0.0.1:8787").rstrip("/")


def _request(method, path, body=None):
    token = os.environ.get("CANVAS_API_TOKEN")
    if not token:
        raise RuntimeError("Set CANVAS_API_TOKEN before calling the canvas API")
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = Request(
        BASE_URL + path,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def get_canvas(room):
    return _request("GET", f"/api/rooms/{room}/canvas")


def apply_actions(room, actions, expected_clock=None, page_id=None):
    body = {"actions": actions}
    if expected_clock is not None:
        body["expectedClock"] = expected_clock
    if page_id is not None:
        body["pageId"] = page_id
    return _request("POST", f"/api/rooms/{room}/actions", body)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "read":
        print(json.dumps(get_canvas(sys.argv[2]), indent=2))
    elif len(sys.argv) == 4 and sys.argv[1] == "apply":
        with open(sys.argv[3], encoding="utf-8") as file:
            print(json.dumps(apply_actions(sys.argv[2], json.load(file)["actions"]), indent=2))
    else:
        raise SystemExit("Usage: python canvas_client.py read <room> | apply <room> <actions.json>")
