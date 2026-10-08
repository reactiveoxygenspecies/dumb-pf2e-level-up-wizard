# PF2e Level Up Wizard (v14 overhaul fork)

A module for PF2e on FoundryVTT that provides a level up assistant for players.

This is a local fork of [BenABaron/pf2e-level-up-wizard](https://github.com/BenABaron/pf2e-level-up-wizard) (originally by Zumanzo), rebuilt for **Foundry VTT v14 (14.364)** and **PF2e 8.x**. If you enjoy the original module consider [buying its author a coffee](https://buymeacoffee.com/zumanzo)!

## What changed in this fork

- **Feat slots come from the system.** The wizard previews the character at the new level (an in-memory copy the system prepares like the real actor) and offers exactly the empty slots the character sheet would show, using the same filters as the sheet's "browse" button. Free Archetype, mythic (including variant tiers), dual-class and other module-added feat sections, versatile heritages and Adopted Ancestry (#84) all work without hard-coded level lists. Class traits come from the class slug, so translated class names work (#89).
- **Archetype feats from other classes.** Feats an archetype unlocks from another class (Avenger's Twin Takedown, for example) are offered once the character has that dedication, at the level the archetype grants them. The data is generated from PF2e's archetype journal (`npm run build:archetype-feats`) and validated against the feat compendium.
- **Prerequisite checking (#93, #87, #95).** Every feat is marked as met, not met, or can't be checked. Same-level choices count, so a skill increase or boost picked in the wizard can qualify a feat. Players can hide feats with unmet prerequisites. Nothing is ever blocked.
- **Applied as one change, with undo (#91).** All actor changes go out in one update; if adding the feats fails, everything is rolled back. Each level-up is recorded, and the most recent one can be undone from the wizard, the history window (right-click the hat), or the API.
- **Intelligence increases (#32).** When a boost raises the Intelligence modifier, the wizard asks for the extra trained skill and offers the extra language.
- **Languages.** Unassigned language slots can be filled in the wizard, respecting the campaign's language rarities.
- **Lore skills** can be increased (they were written to the wrong place before).
- **Attribute boosts** use the system's own allowed-boost counts and partial-boost rule, and skip characters with manually entered attributes.
- **Optional choices (#90).** "Require All Choices" can be turned off so players can leave slots empty for later.
- **Rarity setting split (#94).** Hide nothing, rare and unique, or uncommon and above.
- **Lock Level Field** now works with "Enforce XP Requirements" (#82).
- **Missed slots.** Empty feat slots from earlier levels are offered as optional picks. If a level was raised by several steps at once (automatic mode), every level in between is handled.
- **Reminders.** A whisper lists what still needs manual work: spell slots for every spellcasting entry (class and archetype, #92), new spell ranks, feats that mention focus spells or cantrips (#66), open languages and empty slots.
- **Faster feat loading.** Compendium indexes are used instead of loading every feat document, and the packs follow the system's Compendium Browser settings (homebrew compendiums included automatically).
- **Better feat picker.** Search (including Babele original names), level range, rarity, archetype and dedication filters, skill filter, a description pane, double-click to choose, and "post to chat" with the system's own chat card.
- **v14 ready.** ApplicationV2 with Handlebars parts throughout, no jQuery in the module's own windows, namespaced Foundry APIs, and the feat picker follows the wizard into v14 pop-out windows.
- **SF2e** is recognized (#88) through the shared system API. This is untested.

## Usage

By default, a wizard hat appears next to the character's level on the character sheet (or in the window header, depending on the client setting).

- **Left-click** opens the wizard for the next level.
- **Right-click** opens the level-up history, with undo for the most recent level-up.

The hat is dimmed when the character can't level up yet (not enough XP, or level 20).

If the GM disables the button, the wizard opens automatically after a character's level is raised manually.

### Macro API

```js
const api = game.modules.get('pf2e-level-up-wizard').api;
api.open(actor);            // open the wizard
api.history(actor);         // show the history window
api.getHistory(actor);      // recorded level-ups
api.undoLastLevelUp(actor); // undo the most recent one (asks for confirmation)
```

## Settings

| Setting | Scope | Notes |
| --- | --- | --- |
| Enable Level-Up Button | World | Off = open the wizard automatically after a manual level change. |
| Level-Up Button Placement | Client | Next to level (small/large) or window header. |
| Lock Level Field | World | Disables the sheet's level input. |
| Enforce XP Requirements | World | Level-ups need enough XP; the XP is deducted. |
| Require All Choices | World | Off = players can leave choices empty. |
| Allow Players to Undo Level-Ups | World | The GM can always undo. |
| Prerequisite Checking | World | Mark prerequisites, or off. |
| Hide Feats with Unmet Prerequisites | Client | Default for the feat picker filter. |
| Hidden Feat Rarities | World | Replaces "Hide Rare and Uncommon Feats" (migrated automatically). |
| Feat Sorting | Client | Default sort in the feat picker. |
| Skill Increase Info | Client | How much detail skill selections show. |
| Send Reminder Whispers to GM | World | Copy the manual-update reminders to the GM. |
| Additional Feat Compendiums | World | Extra compendiums beyond the Compendium Browser's selection. |

## Development

```bash
npm install
npm run lint
npm test
```

`npm test` runs the unit tests (prerequisite parser, slot matching and boost math against real PF2e data) and checks that every localization key exists. The data tests read a PF2e source checkout; pass its path with `PF2E_SOURCE=/path/to/pf2e`. `tests/prereq-coverage.mjs <pf2e-path>` reports how many real prerequisite lines the parser understands.

## Credits

Original module by Zumanzo, maintained by BenABaron and contributors, with translations by the community. Licensed under the terms in [LICENSE](LICENSE).
