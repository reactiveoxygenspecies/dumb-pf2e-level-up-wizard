import { loadDocument } from './abcIndex.js';

/*
 * Feats that make the character trained in a skill (Bouncy Goblin: Acrobatics). When the character is
 * already trained in it, the rules give another skill of their choice instead; the system doesn't, so
 * the wizard and the builder ask for that skill.
 */

const SKILL_RANK_PATH = /^system\.skills\.([a-z-]+)\.rank$/;

/**
 * Skills a feat source trains on its own: an unconditional "at least trained" on a named skill.
 * Choices (a skill picked in the system's prompt) and conditional trainings are left out.
 * @param {object} source item source or document
 * @param {string[]} skills the skill slugs that count (lores don't)
 */
export const trainedSkillsOf = (source, skills) => {
  const out = [];
  for (const rule of source?.system?.rules ?? source?._source?.system?.rules ?? []) {
    if (rule?.key !== 'ActiveEffectLike' || !['upgrade', 'override'].includes(rule.mode)) continue;
    if (Number(rule.value) !== 1 || (rule.predicate ?? []).length) continue;
    const slug = SKILL_RANK_PATH.exec(rule.path ?? '')?.[1];
    if (slug && skills.includes(slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
};

/**
 * Trainings that land on a skill the character already has, in slot order. A skill one picked feat
 * trains counts as trained for the feats after it.
 * @param {{ key: string, name: string, skills: string[] }[]} picks
 * @param {Iterable<string>} trained skills trained before these feats
 * @returns {{ key: string, slotKey: string, featName: string, skill: string }[]}
 */
export const overlappingTrainings = (picks, trained) => {
  const have = new Set(trained);
  const overlaps = [];
  for (const pick of picks) {
    for (const skill of pick.skills) {
      if (have.has(skill)) overlaps.push({ key: `${pick.key}:${skill}`, slotKey: pick.key, featName: pick.name, skill });
      else have.add(skill);
    }
  }
  return overlaps;
};

/** Drop replacement skills whose overlap went away; returns the kept ones */
export const keepReplacements = (replacements, overlaps) => {
  const live = new Set(overlaps.map((o) => o.key));
  return Object.fromEntries(Object.entries(replacements ?? {}).filter(([key, slug]) => live.has(key) && slug));
};

/** Skills each picked feat trains, read from the feat documents (cached) */
export const pickTrainings = async (picks, skills) => {
  const out = [];
  for (const { key, uuid, name } of picks) {
    const doc = await loadDocument(uuid);
    out.push({ key, name, skills: doc ? trainedSkillsOf(doc, skills) : [] });
  }
  return out;
};
