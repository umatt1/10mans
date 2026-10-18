"""Write data/version.json: the commit being deployed and when the sheet data was last read.
scripts/cooldown.js reads the previous deployment's copy to decide whether a rebuild of the same commit is allowed."""
import json, os
from datetime import datetime, timezone

stats = json.load(open("data/stats.json"))
json.dump({
    "sha": os.environ.get("VERCEL_GIT_COMMIT_SHA", ""),
    "syncedAt": stats["updated"],          # unchanged when the sheet fetch failed, so a failed sync never starts the cooldown
    "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
}, open("data/version.json", "w"))
