import { traitRequirements, worstStatus } from '../helpers/prerequisites.js';
import { localize } from '../helpers/utility.js';

/* -------------------------------------------- */
/*  Layout: single page or steps                */
/* -------------------------------------------- */

/**
 * Auto-switch between the two layouts. A level-up is shown on ONE page (overview with the left rail) when
 * it has at most SINGLE_PAGE_MAX_GROUPS choice groups AND the choices are estimated to fit one screen
 * (SINGLE_PAGE_BUDGET px of the main column, about what a 780 px tall window shows below the title).
 * Anything bigger is split into step tabs (Feats, Skills, Boosts, Extras, Review) so nothing scrolls away.
 *
 * A "choice group" is: each feat slot, each skill increase, each attribute boost set, and one each for
 * the Intelligence skill, the languages and the skill potency choices. Typical results: a level with a
 * class feat and a skill feat is one page; a level with a skill increase grid plus a feat, or with
 * attribute boosts, is stepped.
 */
export const SINGLE_PAGE_MAX_GROUPS = 3;
export const SINGLE_PAGE_BUDGET = 560;

/** Estimated heights (px) of each kind of choice block in the single page layout */
const HEIGHT = {
  featCard: 150,
  optionalRow: 56,
  gridHead: 96,
  gridRow: 56,
  gridColumns: 3,
  boostSet: 200,
  languages: 120
};

const gridHeight = (options) =>
  HEIGHT.gridHead + HEIGHT.gridRow * Math.ceil(options / HEIGHT.gridColumns);

/**
 * @param {object} counts what the level-up asks for, known when the wizard opens
 * @param {number} counts.feats feat slots gained at this level
 * @param {boolean} counts.optionalFeats empty slots from earlier levels exist
 * @param {number} counts.skillIncreases skill increases
 * @param {number} counts.skillOptions skills a skill increase can pick from
 * @param {number} counts.boostSets attribute boost sets
 * @param {number} counts.languages open language slots
 * @param {number} counts.potency potency choices (automatic bonus progression)
 * @param {number} counts.potencyOptions skills a potency choice can pick from
 */
export const chooseLayout = (counts) => {
  const c = {
    feats: 0,
    optionalFeats: false,
    skillIncreases: 0,
    skillOptions: 0,
    boostSets: 0,
    languages: 0,
    potency: 0,
    potencyOptions: 0,
    ...counts
  };
  const groups =
    c.feats + c.skillIncreases + c.boostSets + (c.languages > 0 ? 1 : 0) + (c.potency > 0 ? 1 : 0);
  const height =
    c.feats * HEIGHT.featCard +
    (c.optionalFeats ? HEIGHT.optionalRow : 0) +
    c.skillIncreases * gridHeight(c.skillOptions) +
    c.boostSets * HEIGHT.boostSet +
    (c.languages > 0 ? HEIGHT.languages : 0) +
    c.potency * gridHeight(c.potencyOptions);
  const stepped = groups > SINGLE_PAGE_MAX_GROUPS || height > SINGLE_PAGE_BUDGET;
  return { layout: stepped ? 'steps' : 'single', groups, height };
};

/* -------------------------------------------- */
/*  Feat presentation                           */
/* -------------------------------------------- */

const GROUP_TYPES = new Set(['ancestry', 'class', 'archetype', 'skill', 'general', 'mythic']);

/** Feat group id to the colour family of the `--lvl-type-*` tokens */
export const groupType = (groupId) => (GROUP_TYPES.has(groupId) ? groupId : 'other');

/** Glyph of the PF2e actions font (1, 2, 3 actions, R reaction, F free action) for a feat index entry */
export const actionGlyph = (actionType, actions) => {
  if (actionType === 'reaction') return { char: 'R', name: 'reaction' };
  if (actionType === 'free') return { char: 'F', name: 'free' };
  if (actionType === 'action' && [1, 2, 3].includes(Number(actions))) {
    return { char: String(Number(actions)), name: ['one', 'two', 'three'][Number(actions) - 1] };
  }
  return null;
};

export const glyphView = (actionType, actions) => {
  const glyph = actionGlyph(actionType, actions);
  return glyph ? { char: glyph.char, label: localize(`selector.action.${glyph.name}`) } : null;
};

const STATUS_ICONS = {
  met: 'fa-circle-check',
  unmet: 'fa-circle-xmark',
  unknown: 'fa-circle-question'
};

const TRAIT_REQUIREMENT_TEXT = {
  reincarnated: () => localize('prerequisites.reincarnated')
};

/**
 * Adds to a verdict of `evaluatePrerequisites` what the feat's prerequisite lines leave out: the
 * requirements it carries in its traits (see `traitRequirements`), and a check for an ancestry
 * feat with no traits and no prerequisites, which says nothing about who can take it.
 */
export const withTraitRequirements = (verdict, entry, ctx) => {
  const traits = entry.traits ?? [];
  const lines = traitRequirements(traits, ctx).map(({ trait, status }) => ({
    text: TRAIT_REQUIREMENT_TEXT[trait]?.() ?? trait,
    status
  }));
  if (entry.category === 'ancestry' && !traits.length && !verdict.results?.length) {
    lines.push({ text: localize('prerequisites.noAncestry'), status: 'unknown' });
  }
  if (!lines.length) return verdict;
  const results = [...(verdict.results ?? []), ...lines];
  return { status: worstStatus(results.map((r) => r.status)), results };
};

/**
 * Prerequisite pill: the status, icon and a text that gives the reason.
 * @param {object|null} verdict result of `evaluatePrerequisites`
 * @param {string[]} prerequisites raw prerequisite lines of the feat
 * @param {boolean} [short] list rows say "Fits" instead of "Prerequisites met"
 */
export const prereqPill = (verdict, prerequisites = [], short = false) => {
  if (!verdict) return null;
  const { status } = verdict;
  let text;
  if (status === 'met') {
    text = short
      ? localize('selector.fits')
      : localize(prerequisites.length ? 'prerequisites.met' : 'prerequisites.none');
  } else if (status === 'unmet') {
    const first = (verdict.results ?? []).find((r) => r.status === 'unmet');
    text = first ? localize('prerequisites.needs', { text: first.text }) : localize('prerequisites.unmet');
  } else {
    text = localize('prerequisites.check');
  }
  return { status, text, icon: STATUS_ICONS[status] ?? STATUS_ICONS.unknown };
};

/** "Ask GM" pill for an uncommon, rare or unique feat; shown beside the prerequisite pill */
export const gmApprovalPill = (rarity) =>
  rarity && rarity !== 'common'
    ? {
        status: 'gm',
        text: localize('prerequisites.askGm'),
        tooltip: localize('prerequisites.askGmHint'),
        icon: 'fa-dice-d20'
      }
    : null;

/** HTML tooltip listing every prerequisite with its verdict; `esc` escapes the lines */
export const prereqTooltip = (verdict, esc) => {
  if (!verdict) return '';
  const mark = { met: '✓', unmet: '✗', unknown: '?' };
  const lines = (verdict.results ?? []).map((r) => `${mark[r.status] ?? '?'} ${esc(r.text)}`).join('<br>');
  return `<strong>${esc(localize(`prerequisites.${verdict.status}`))}</strong>${lines ? `<br>${lines}` : ''}`;
};

/* -------------------------------------------- */
/*  Skills                                      */
/* -------------------------------------------- */

/** Four dots for trained, expert, master and legendary; `gained` marks the rank a choice adds */
export const rankDots = (from, to) =>
  [1, 2, 3, 4].map((rank) => ({
    rank,
    filled: rank <= to,
    gained: rank > from && rank <= to
  }));

/**
 * Rank changes of the chosen skill increases and Intelligence trainings, as the apply step computes them:
 * every pick raises the rank one step, picking a skill twice raises it twice.
 */
export const mergeSkillChanges = (skillOptions, picks) => {
  const changes = new Map();
  for (const slug of picks) {
    if (!slug) continue;
    const option = skillOptions.find((s) => s.slug === slug);
    if (!option) continue;
    const entry = changes.get(slug) ?? { label: option.label, from: option.rank, to: option.rank };
    entry.to = Math.min(entry.to + 1, 4);
    changes.set(slug, entry);
  }
  return [...changes.values()];
};

/* -------------------------------------------- */
/*  Languages                                   */
/* -------------------------------------------- */

const VISIBLE_LANGUAGES = 8;

/**
 * Language chips: the first common languages the character does not know, plus anything chosen. The full
 * list (uncommon and rare included) is behind "More languages".
 */
export const languageChips = (options, chosen, expanded) => {
  if (expanded) return { chips: options, hasMore: false };
  const common = new Set(
    options.filter((l) => l.rarity === 'common').slice(0, VISIBLE_LANGUAGES).map((l) => l.slug)
  );
  const chips = options.filter((l) => common.has(l.slug) || chosen.includes(l.slug));
  return { chips, hasMore: chips.length < options.length };
};

/* -------------------------------------------- */
/*  Dates and numbers                           */
/* -------------------------------------------- */

/** "today, 13:24", "yesterday, 09:10" or "12 Mar, 18:00" */
export const dayLabel = (timestamp, lang = 'en', now = new Date()) => {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  let day;
  if (days >= 0 && days <= 1) {
    day = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-days, 'day');
  } else {
    day = date.toLocaleDateString(lang, { day: 'numeric', month: 'short' });
  }
  return `${day}, ${time}`;
};

export const formatNumber = (n, lang = 'en') => Number(n ?? 0).toLocaleString(lang);

/** "A, B and C" in the user's language */
export const joinList = (items, lang = 'en') => {
  try {
    return new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
};
