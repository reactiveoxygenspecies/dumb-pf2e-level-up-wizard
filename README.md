# PF2e Level Up Wizard

A module for PF2e on FoundryVTT that provides a level up assistant for players.

If you enjoy the module consider [buying me a coffee](https://buymeacoffee.com/zumanzo)!

## Installation

This module can be installed directly in Foundry via `Install Modules` and searching for the name. Alternatively you can install it via manifest using this link: `https://github.com/BenABaron/pf2e-level-up-wizard/releases/latest/download/module.json`

## Usage

By default, a wizard hat will be rendered on the character sheet that can be clicked to start the Wizard. This icon can also be moved to the toolbar.
Alternatively, you can disable the icon, which will cause the wizard to render when a character's level changes.

### The Wizard

Once started, the wizard will show the player any new feature they gained with their level up, as well as prompting them to make any relevant selections if available.
Follow the steps on screen, hit submit (and confirm!), and watch as the wizard handles all of the necessary changes to the character sheet!

https://github.com/user-attachments/assets/b4e5e900-ec99-45a8-b3c6-c9c395d7b56c

### Feat Selection

Any time a feat selection is prompted, the wizard will only show you feats that correspond to the character's information.
These feats can be filtered and sorted, allowing for an easier time finding the feat that you're looking for!

Current filters include:
- Search by Name
- Level Min
- Level Max
- Show Archetype Feats (Class and Skill Feats only)
- Search by Dedication (if Show Archetype Feats is enabled, or for Free Archetype Feats)

![Wizard Feat Selector](https://github.com/user-attachments/assets/ae718fd4-1052-4e2e-a51c-5b12292c41c5)

### Chat Messages

Upon level up completion, the wizard will send a confirmation message in chat to all players detailing selected feats and skill increases selected by the player.
In addition, if the player character is a spellcaster, they will receive a whisper reminding them to update their spell slots.

![Wizard Chat Message](https://github.com/user-attachments/assets/8be8a95c-2960-4df3-808e-a3120f4ab137)

## Settings

- **Enable Level Up Button (GM Only)**: Choose whether to show a Level-Up button on character sheets. When disabled, the Level-Up Wizard will activate automatically after manually updating a character's level.
- **Level-Up Button Placement**: Select where the Level-Up button appears: either next to the character's level or in the toolbar at the top of the character sheet.
- **Feat Sorting Method**: Choose how feats should be sorted by default.
- **Display Feat Prerequisites (GM Only)**: Toggle whether an asterisk (*) appears next to Feats with prerequisites in dropdowns.
- **Disable Level Input (GM Only)**: If enabled, the default level input on the character sheet will be disabled to encourage the use of the Level-Up Wizard for leveling up. This setting has no effect if the 'Enable Level-Up Button' setting is disabled.
- **Send Manual Update Whispers to GM (GM Only)**: When enabled, whispers about required manual updates (such as spell updates) will also be sent to the GM in addition to the player.

## Future

You can find the project board of planned features at the [PF2e Level-Up Wizard Workshop](https://github.com/users/BenABaron/projects/1)

## Bug Reporting, Issues, & Feature Requests

**Note**: Before submitting an Feature Request, please check the [project board](https://github.com/users/BenABaron/projects/1) to see if the feature is already planned.

Feel free to reach out to me on Discord at Zumanzo#8754, and/or open an [issue on Github](https://github.com/BenABaron/pf2e-level-up-wizard/issues).

## Contributing

I'm always happy to accept contribution from others! If you'd like to contribute, please follow these guidelines:

- Create branch out of latest `main` branch. Make sure to do a `git pull origin/main` for latest copy.
- Branch names should be a description of the feature being implemented/bug being fixed (i.e. `my-feature`, `bug-123-bug-summary`), preferring dashes over camelCasing in branch names.
- When ready for review, open a PR from your feature branch against `main`.
