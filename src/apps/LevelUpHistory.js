import { MODULE_ID, TEMPLATE_PATH } from '../constants.js';
import { canUndo, getHistory, undoLastLevelUp } from '../data/apply.js';
import { localize } from '../helpers/utility.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Read-only list of the level-ups the wizard applied to an actor, with undo for the latest one */
export class LevelUpHistory extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super({
      ...options,
      id: `${MODULE_ID}-history-${options.actor.uuid.replace(/\./g, '-')}`
    });
    this.actor = options.actor;
  }

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, 'level-up-history'],
    window: { icon: 'fa-solid fa-clock-rotate-left', resizable: true },
    position: { width: 480, height: 'auto' },
    actions: {
      undo: LevelUpHistory.#onUndo
    }
  };

  static PARTS = {
    list: { template: `${TEMPLATE_PATH}/level-up-history.hbs`, scrollable: [''] }
  };

  get title() {
    return localize('history.windowTitle', { actorName: this.actor.name });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const history = getHistory(this.actor);
    const undoable = canUndo(this.actor);
    const entries = history
      .map((entry, i) => ({
        ...entry,
        date: new Date(entry.timestamp).toLocaleString(game.i18n.lang),
        user: game.users.get(entry.userId)?.name ?? '—',
        levels: entry.levelChanged
          ? `${entry.fromLevel} → ${entry.toLevel}`
          : `${entry.toLevel}`,
        isLatest: i === history.length - 1,
        canUndo: undoable && i === history.length - 1
      }))
      .reverse();
    return Object.assign(context, { entries, actorName: this.actor.name });
  }

  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    this._hookId = Hooks.on('updateActor', (actor) => {
      if (actor === this.actor) this.render();
    });
  }

  _onClose(options) {
    super._onClose(options);
    if (this._hookId) Hooks.off('updateActor', this._hookId);
  }

  static async #onUndo() {
    if (await undoLastLevelUp(this.actor, { windowId: this.window.windowId })) this.render();
  }
}
