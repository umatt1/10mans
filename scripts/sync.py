"""Pull every player tab from the public Google Sheet into data/stats.json.

Nothing is hard-coded: the sheet id lives in data/sheet.json and the tabs are discovered each run (the sheet is exported
once as xlsx just to read its tab names). A tab counts as a player tab when its header row has the stat columns, so a
new player is picked up by adding a tab to the sheet, and helper tabs (Leaderboards, Patch Notes, ...) are skipped.
If one tab fails to download its previous rows are kept; if tab discovery fails the previous player list is reused.
"""
import csv, html, io, json, os, re, sys, urllib.parse, urllib.request, zipfile
from datetime import datetime, timezone

CONFIG = json.load(open("data/sheet.json"))
SHEET_ID = CONFIG["sheetId"]
EXCLUDE = {t.lower() for t in CONFIG.get("excludeTabs", [])}

# header aliases -> canonical column (compared lowercase, ignoring spaces, % and punctuation)
ALIASES = {
    "map": "map", "date": "date", "kills": "k", "kill": "k", "k": "k", "death": "d", "deaths": "d", "d": "d",
    "assist": "a", "assists": "a", "a": "a", "hs": "hs", "hspct": "hs", "headshot": "hs", "headshots": "hs",
    "dmg": "dmg", "damage": "dmg", "rounds": "rounds", "round": "rounds", "adr": "adr",
}
REQUIRED = {"map", "date", "k", "d", "a", "rounds"}


def http(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read()


def list_tabs():
    """Tab names, in order, read from the workbook's xlsx export."""
    data = http(f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=xlsx")
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = z.read("xl/workbook.xml").decode()
    return [html.unescape(n) for n in re.findall(r'<sheet\b[^>]*\bname="([^"]*)"', xml)]


def fetch_tab(tab):
    return http(f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&sheet="
                + urllib.parse.quote(tab)).decode()


def canon(h):
    return ALIASES.get(re.sub(r"[^a-z]", "", h.lower().replace("%", "pct")))


def header_map(first_row):
    """column index -> canonical name, or None when this is not a stats header."""
    cols = {}
    for i, h in enumerate(first_row):
        c = canon(h)
        if c and c not in cols.values():
            cols[i] = c
    return cols if REQUIRED <= set(cols.values()) else None


def num(s):
    s = str(s).strip().replace("%", "").replace(",", "")
    try:
        return float(s) if s else 0.0
    except ValueError:
        return 0.0


def norm_date(s):
    """m/d/yy, m/d/yyyy or yyyy-mm-dd -> yyyy-mm-dd (None if unreadable)."""
    s = s.strip()
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        y, mo, d = m.groups()
    else:
        m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})", s)
        if not m:
            return None
        mo, d, y = m.groups()
        y = y if len(y) == 4 else "20" + y
    return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"


def parse(text):
    """Stat rows from a tab's CSV, or None if it is not a stats tab."""
    table = list(csv.reader(io.StringIO(text)))
    if not table:
        return None
    cols = header_map(table[0])
    if cols is None:
        return None
    rows = []
    for line in table[1:]:
        v = {name: (line[i] if i < len(line) else "") for i, name in cols.items()}
        date = norm_date(v["date"])
        if not v["map"].strip() or not date:
            continue
        rounds = int(num(v["rounds"]))
        dmg = int(num(v["dmg"])) if "dmg" in v else int(round(num(v.get("adr", "0")) * rounds))
        rows.append({"map": v["map"].strip(), "date": date, "k": int(num(v["k"])), "d": int(num(v["d"])), "a": int(num(v["a"])),
                     "hs": num(v.get("hs", "0")), "dmg": dmg, "rounds": rounds})
    return rows


def main():
    previous = {}
    if os.path.exists("data/stats.json"):
        previous = json.load(open("data/stats.json")).get("players", {})
    try:
        tabs = list_tabs()
    except Exception as e:
        tabs = list(previous)
        print(f"could not read the tab list ({e}); reusing the {len(tabs)} known players", file=sys.stderr)
    out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "players": {}}
    skipped, kept = [], []
    for tab in tabs:
        if tab.lower() in EXCLUDE:
            skipped.append(tab)
            continue
        try:
            rows = parse(fetch_tab(tab))
        except Exception as e:
            if tab in previous:
                out["players"][tab] = previous[tab]
                kept.append(tab)
                print(f"tab {tab!r} failed ({e}); kept its previous rows", file=sys.stderr)
            continue
        if rows is None:
            skipped.append(tab)
        else:
            out["players"][tab] = rows
    if not any(out["players"].values()):
        sys.exit("no rows fetched; refusing to overwrite data")
    with open("data/stats.json", "w") as f:
        json.dump(out, f, separators=(",", ":"))
    new = [p for p in out["players"] if p not in previous]
    print({p: len(r) for p, r in out["players"].items()})
    print("skipped (not stat tabs):", skipped, "| new players:", new, "| kept old rows for:", kept)


if __name__ == "__main__":
    main()
