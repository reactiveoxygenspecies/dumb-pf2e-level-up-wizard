import { MODULE_ID, TEMPLATE_PATH } from '../constants.js';
import { canUndo, getHistory, undoLastLevelUp } from '../data/apply.js';
import { localize } from '../helpers/utility.js';
import { dayLabel } from './wizardView.js';

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
    classes: [MODULE_ID, 'lvlup-history'],
    window: { icon: 'fa-solid fa-clock-rotate-left', resizable: true },
    position: { width: 400, height: 'auto' },
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
    const lang = game.i18n.lang;
    // Newest first; each entry becomes one line of the timeline
    const entries = history
      .map((entry, i) => {
        const summary = entry.summary ?? {};
        const items = [
          // A character build lists its ancestry, heritage, background, class and deity first
          ...(summary.build ?? []).map((name) => ({ label: name })),
          ...(summary.feats ?? []).map((f) => ({ label: f.name, uuid: f.uuid, title: f.slot })),
          ...(summary.skills ?? []).map((s) => ({ label: `${s.label}: ${s.rank}` })),
          ...(summary.boosts ?? []).map((b) => ({
            label: localize('history.boost', { attribute: b })
          })),
          ...(summary.languages ?? []).map((l) => ({ label: l })),
          ...(summary.potency ?? []).map((p) => ({ label: `${p.label} +${p.value}` }))
        ];
        return {
          id: entry.id,
          level: entry.toLevel,
          levels: entry.levelChanged
            ? `${entry.fromLevel} → ${entry.toLevel}`
            : `${entry.toLevel}`,
          heading:
            entry.kind === 'build'
              ? localize('history.built')
              : localize('history.level', {
                  levels: entry.levelChanged
                    ? `${entry.fromLevel} → ${entry.toLevel}`
                    : `${entry.toLevel}`
                }),
          date: dayLabel(entry.timestamp, lang),
          fullDate: new Date(entry.timestamp).toLocaleString(lang),
          user: game.users.get(entry.userId)?.name ?? '—',
          items,
          isLatest: i === history.length - 1,
          canUndo: undoable && i === history.length - 1
        };
      })
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
