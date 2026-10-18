"""Compile data/matches/*.json (one file or an array per match) into data/matches.json.

Fails loudly on a bad file so the workflow / PR check catches it.
"""
import glob, json, re, sys

errors, matches, seen = [], [], {}


def check(m, path):
    problems = []
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(m.get("date", ""))):
        problems.append("date must be YYYY-MM-DD")
    if not m.get("map"):
        problems.append("map missing")
    sc = m.get("score")
    if not (isinstance(sc, list) and len(sc) == 2 and all(isinstance(x, int) for x in sc)):
        problems.append("score must be [int, int]")
    if ("win" in m) != ("lose" in m):
        problems.append("win and lose must both be present")
    for side in ("win", "lose"):
        for p in m.get(side, []):
            if not p.get("name") or not all(isinstance(p.get(k), (int, float)) for k in ("k", "d", "a")):
                problems.append(f"{side}: player needs name, k, d, a ({p.get('name')})")
    if not m.get("id"):
        m["id"] = f"{m.get('date')}-{str(m.get('map')).lower()}-{'-'.join(map(str, sc or []))}"
    key = (m.get("date"), str(m.get("map")).lower(), tuple(sc or []))
    if m["id"] in seen or key in seen:
        problems.append(f"duplicate of {seen.get(m['id']) or seen.get(key)}")
    for p in problems:
        errors.append(f"{path}: {p}")
    if not problems:
        seen[m["id"]] = seen[key] = path
        matches.append(m)


for path in sorted(glob.glob("data/matches/*.json")):
    try:
        data = json.load(open(path))
    except ValueError as e:
        errors.append(f"{path}: invalid JSON ({e})")
        continue
    for m in (data if isinstance(data, list) else data.get("matches", [data])):
        check(m, path)

if errors:
    sys.exit("\n".join(errors))
matches.sort(key=lambda m: (m["date"], m.get("time", "")), reverse=True)
aliases = json.load(open("data/aliases.json"))
json.dump({"aliases": aliases, "matches": matches}, open("data/matches.json", "w"), indent=1)
print(f"{len(matches)} matches")
