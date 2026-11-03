# Heresy Muster

An army list builder for Horus Heresy 3rd edition. It reads the community
[BSData](https://github.com/BSData/horus-heresy-3rd-edition) files straight
from GitHub at one fixed commit, so the data (and its rule text) never changes
under you.

- Pinned commit: `5166ba2b10a7b18b1757186191a57a900050e628` (3 Nov 2026)
- No server, no accounts, no build step. It's plain HTML, CSS and JavaScript.
- Each browser downloads the data once (about 5–15 MB depending on faction) and keeps it.
- Lists are saved in each person's own browser. Move them with share links or list files.

## What it does

- All factions in the data, including allied forces from another faction
- Crusade Force Organization Chart with Primary, Auxiliary, Apex and Warlord detachments, plus Zone Mortalis
- Unit options, wargear, model counts and points, using the data's own rules for costs and limits
- Validation: slot limits, minimum and maximum choices, unit restrictions and the data's own error messages
- Unit profiles, weapon tables and rule text on tap
- Text export, share links and list files
- Collapsible forces, and saved presets for units and detachments
- Suggestions from your own habits: units you often take together, and your usual
  loadout for a unit. Learned only from lists and presets saved in your browser;
  presets count extra. It never ranks units by strength.

## Put it online (free)

Pick one. Both give you a normal web address to send your friends.

### Option A: GitHub Pages

1. Sign in at github.com and create a new **public** repository, for example `heresy-muster`.
2. On the repository page choose **Add file → Upload files**, drag in everything from this folder
   (keep the `js` and `css` folders), and press **Commit changes**.
3. Go to **Settings → Pages**. Under *Build and deployment* pick **Deploy from a branch**,
   branch `main`, folder `/ (root)`, and press **Save**.
4. After a minute or two the page shows your address, like
   `https://your-name.github.io/heresy-muster/`.

### Option B: Netlify Drop

1. Open <https://app.netlify.com/drop> on a computer.
2. Drag this whole folder onto the page.
3. Netlify gives you an address right away. Create a free account to keep it permanently.

Opening `index.html` straight from your disk will not work, because browsers block
module scripts on `file://` pages. To try it locally, run a tiny web server in this folder:

```
python3 -m http.server 8000
```

and open <http://localhost:8000>.

## Changing the data version

Edit `js/config.js`: set `DATA_COMMIT` (full 40-character hash) and `DATA_DATE`.
If the new commit adds, removes or renames catalogue files, regenerate `js/manifest.js`
from that commit. It lists each file's name, id, size and catalogue links.

Saved lists refer to entries by their data ids, so lists made on one commit usually open
on a nearby one. Entries that no longer exist show as a warning.

## Local corrections

`js/corrections.js` lists fixes to mistakes in the BSData files. Each one removes a single
entry or option by its data id after the files download. Saved lists that used a removed
option drop it when opened. Current corrections:

- Scorpius Missile Tank: Pintle #2 offered a Combi-bolter, but only one of the two
  Pintle Mounted bolters may be exchanged. Pintle #2 now stays a bolter.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell |
| `css/app.css` | All styling, light and dark |
| `js/config.js` | Data repository and pinned commit |
| `js/manifest.js` | Catalogue list for the pinned commit |
| `js/loader.js` | Downloads data files and caches them in the browser |
| `js/data.js` | Indexes the data and resolves links between catalogues |
| `js/engine.js` | Rules engine: modifiers, conditions, constraints, costs, validation |
| `js/corrections.js` | Local fixes to mistakes in the data |
| `js/export.js` | Plain-text list export |
| `js/store.js` | Saved lists and share links |
| `js/main.js` | Interface |
| `tools/` | Node test scripts (`node tools/test-all.mjs <data-folder>`) |

## Limits

- The engine follows BattleScribe and New Recruit behaviour closely, but it's an independent
  implementation. If a validation message looks wrong, compare with the data in the repository.
- Percentage-based limits in the data are not checked.
- Lists don't sync between devices. Use a share link or a list file to move one.
