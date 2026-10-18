"""One-time import of Refrag scrim scoreboards (copied from the logged-in match pages).

Row: name, roles, rating, K, D, A, hs%, adr, kast. First five rows of each match are the winning team.
"""
import json

P = lambda n, r, rt, k, d, a, hs, kpr, adr, kast: dict(
    name=n, roles=r, rating=rt, k=k, d=d, a=a, hs=hs, kpr=kpr, adr=adr, kast=kast)

matches = [
    dict(id="f8c854ca-4026-4371-bd01-775d3b888015", date="2026-10-17", map="Dust2", score=[13, 10], source="refrag",
         win=[P("OATH", ["AWPer", "Lurker"], 1.23, 22, 16, 9, 54.5, .96, 101.13, .74),
              P("The Swooper", ["Support"], 1.19, 19, 15, 6, 73.7, .83, 88.13, .83),
              P("Dave Blunts", ["Entry"], 1.14, 16, 15, 4, 50.0, .70, 77.52, .83),
              P("Sema", ["AWPer"], 1.09, 17, 14, 5, 52.9, .74, 83.7, .78),
              P("travypatty", ["Support"], 0.67, 18, 15, 7, 72.2, .78, 76.3, .83)],
         lose=[P("The Za", ["Support"], .93, 20, 17, 7, 50.0, .87, 108.61, .78),
               P("Noah Jawn", ["Support", "AWPer"], .89, 13, 19, 8, 76.9, .57, 76.83, .65),
               P("zDemoncake", ["Rifler"], .71, 13, 20, 3, 61.5, .57, 67.91, .61),
               P("ByMax", ["AWPer", "Entry"], .63, 15, 19, 6, 20.0, .65, 76.0, .57),
               P("Tigereye16", ["Lurker"], .52, 13, 17, 2, 23.1, .57, 46.17, .61)]),
    dict(id="9809ad9a-d600-4301-ab93-4aa782a30365", date="2026-10-17", map="Anubis", score=[13, 4], source="refrag",
         win=[P("Dave Blunts", ["Support"], 1.23, 16, 7, 2, 62.5, .94, 68.47, .82),
              P("The Swooper", ["Support"], 1.14, 19, 9, 3, 52.6, 1.12, 108.12, .82),
              P("OATH", ["Lurker"], .79, 22, 10, 7, 36.4, 1.29, 130.06, .82),
              P("Sema", ["AWPer", "Entry"], .76, 9, 13, 6, 55.6, .53, 60.41, .71),
              P("travypatty", ["Rifler"], .47, 9, 11, 11, 11.1, .53, 86.06, .88)],
         lose=[P("zDemoncake", ["Support", "Lurker"], 1.48, 8, 16, 5, 62.5, .47, 71.82, .53),
               P("Noah Jawn", ["AWPer"], 1.38, 15, 15, 5, 46.7, .88, 97.18, .71),
               P("ByMax", ["AWPer", "Support"], 1.33, 13, 13, 2, 46.2, .76, 75.24, .65),
               P("The Za", ["Entry"], 1.09, 11, 14, 3, 63.6, .65, 93.06, .59),
               P("Tigereye16", ["Rifler"], .49, 2, 17, 2, 0.0, .12, 12.94, .24)]),
]
# Older uploaded demos have scores and maps only; Refrag has no scoreboard for them.
for d, m, s in [("2026-04-10", "Mirage", [13, 3]), ("2026-04-10", "Ancient", [13, 8]), ("2026-04-10", "Overpass", [13, 7]),
                ("2026-02-22", "Inferno", [13, 5]), ("2026-02-22", "Anubis", [13, 11]), ("2026-01-16", "Inferno", [15, 9])]:
    matches.append(dict(date=d, map=m, score=s, source="refrag-demo-list"))

# Refrag in-game name -> sheet tab name, matched on identical K/D/A across both scrims.
aliases = {"OATH": "Will", "The Swooper": "Morgan", "Dave Blunts": "Matt", "Sema": "Ethan", "travypatty": "Travis",
           "The Za": "Brandon", "Noah Jawn": "Noah", "zDemoncake": "Cristian", "ByMax": "Max", "Tigereye16": "Mark"}
with open("data/matches.json", "w") as f:
    json.dump({"aliases": aliases, "matches": matches}, f, indent=1)
