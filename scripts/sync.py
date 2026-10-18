"""Pull every player tab from the public stats sheet into data/stats.json."""
import csv, io, json, sys, urllib.parse, urllib.request
from datetime import datetime, timezone

SHEET_ID = "1RknwngIMQYAuY7AwgZC3bijaTwWZDDh5yw4A6kZpnPM"
PLAYERS = ["Alfa", "Antor", "Brandon", "Cristian", "Devante", "Ethan", "Jamal", "Juicy",
           "Mark", "Matt", "Max", "Megan", "Morgan", "Nathan", "Noah", "Travis", "Victor", "Will"]


def fetch(tab):
    url = (f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&sheet="
           + urllib.parse.quote(tab))
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode()


def num(s):
    s = s.strip().replace("%", "")
    return float(s) if s else 0.0


def parse(text):
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        if not r.get("Map") or not r.get("Date"):
            continue
        m, d, y = r["Date"].split("/")
        rows.append({
            "map": r["Map"], "date": f"20{y}-{int(m):02d}-{int(d):02d}",
            "k": int(num(r["Kills"])), "d": int(num(r["Death"])), "a": int(num(r["Assist"])),
            "hs": num(r["HS %"]), "dmg": int(num(r["DMG"])), "rounds": int(num(r["Rounds"])),
        })
    return rows


def main():
    out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "players": {}}
    for p in PLAYERS:
        out["players"][p] = parse(fetch(p))
    if not any(out["players"].values()):
        sys.exit("no rows fetched; refusing to overwrite data")
    with open("data/stats.json", "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print({p: len(r) for p, r in out["players"].items()})


if __name__ == "__main__":
    main()
