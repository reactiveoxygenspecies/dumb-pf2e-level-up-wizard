import { spellCandidates } from '../data/spellcasting.js';
import { localize } from '../helpers/utility.js';

/**
 * View data for the shared spell picker (templates/partials/spell-picker.hbs).
 * @param {object} options
 * @param {object[]} options.picks from `spellPicks`
 * @param {object[]} options.index spell index
 * @param {Record<string, string[]>} options.selection pick key → chosen spell uuids
 * @param {string|null} options.tradition
 * @param {Set<string>} options.known uuids/slugs the entry already holds
 * @param {string[]} options.hiddenRarities
 * @param {Record<string, string>} options.search pick key → search text
 */
export const spellPickerView = ({ picks, index, selection, tradition, known, hiddenRarities, search = {} }) => {
  const chosenAnywhere = new Set(Object.values(selection).flat());
  return picks.map((pick) => {
    const chosen = selection[pick.key] ?? [];
    const elsewhere = new Set([...chosenAnywhere].filter((uuid) => !chosen.includes(uuid)));
    const candidates = spellCandidates(index, pick, {
      tradition,
      known: new Set([...known, ...elsewhere]),
      hiddenRarities
    });
    const term = (search[pick.key] ?? '').trim().toLocaleLowerCase();
    const full = chosen.length >= pick.count;
    return {
      key: pick.key,
      label: pick.label,
      count: pick.count,
      chosenCount: chosen.length,
      complete: chosen.length === pick.count,
      search: search[pick.key] ?? '',
      empty: candidates.length === 0,
      rows: candidates.map((s) => ({
        uuid: s.uuid,
        name: s.name,
        img: s.img,
        searchText: s.searchText,
        hidden: !!term && !s.searchText.includes(term),
        rankLabel: s.cantrip ? localize('spells.cantrip') : localize('spells.rankShort', { rank: s.rank }),
        rarity: s.rarity,
        rarityLabel:
          s.rarity === 'common'
            ? null
            : game.i18n.localize(CONFIG.PF2E?.rarityTraits?.[s.rarity] ?? s.rarity),
        chosen: chosen.includes(s.uuid),
        disabled: full && !chosen.includes(s.uuid)
      }))
    };
  });
};

/** Toggle a spell in a pick, respecting its count; returns the new selection */
export const toggleSpell = (selection, picks, pickKey, uuid) => {
  const pick = picks.find((p) => p.key === pickKey);
  if (!pick) return selection;
  const chosen = selection[pickKey] ?? [];
  if (chosen.includes(uuid)) return { ...selection, [pickKey]: chosen.filter((u) => u !== uuid) };
  if (chosen.length >= pick.count) return selection;
  return { ...selection, [pickKey]: [...chosen, uuid] };
};

/** Drop selections for picks that no longer exist and trim to their counts */
export const trimSpellSelection = (selection, picks) =>
  Object.fromEntries(
    picks
      .filter((p) => selection[p.key]?.length)
      .map((p) => [p.key, selection[p.key].slice(0, p.count)])
  );

/**
 * Scroll offsets of each group's list and the focused spell button. The app only keeps the scroll of
 * its main pane, so without this a pick sends every list back to the top.
 */
export const captureSpellScroll = (root) => {
  if (!root) return null;
  const lists = {};
  root.querySelectorAll('[data-spell-group]').forEach((group) => {
    const list = group.querySelector('.lvl-spell-list');
    if (list) lists[group.dataset.spellGroup] = list.scrollTop;
  });
  const active = root.ownerDocument.activeElement;
  const focus = active?.matches?.('[data-action="toggleSpell"]') && root.contains(active)
    ? { pick: active.dataset.pick, uuid: active.dataset.uuid }
    : null;
  return { lists, focus };
};

export const restoreSpellScroll = (root, saved) => {
  if (!root || !saved) return;
  for (const [key, top] of Object.entries(saved.lists)) {
    const list = root.querySelector(`[data-spell-group="${CSS.escape(key)}"] .lvl-spell-list`);
    if (list) list.scrollTop = top;
  }
  if (saved.focus) {
    const { pick, uuid } = saved.focus;
    root
      .querySelector(`[data-action="toggleSpell"][data-pick="${CSS.escape(pick)}"][data-uuid="${CSS.escape(uuid)}"]`)
      ?.focus({ preventScroll: true });
  }
};

/** Attach search filtering to a rendered picker; filtering only hides rows, no re-render */
export const bindSpellSearch = (root, searchState) => {
  root.querySelectorAll('[data-spell-search]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const key = event.currentTarget.dataset.spellSearch;
      const term = event.currentTarget.value;
      searchState[key] = term;
      const needle = term.trim().toLocaleLowerCase();
      const group = event.currentTarget.closest('[data-spell-group]');
      group?.querySelectorAll('[data-spell-row]').forEach((row) => {
        row.hidden = !!needle && !row.dataset.search.includes(needle);
      });
    });
  });
};
