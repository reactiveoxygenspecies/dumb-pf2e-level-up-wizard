import { MODULE_ID } from '../constants.js';
import { escapeHTML, localize } from './utility.js';

const list = (items) =>
  items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '';

/** Public summary of the level-up plus a whisper listing what still needs manual work */
export const postLevelUpMessages = async (actor, plan, selection, summary, spellHints) => {
  const speaker = ChatMessage.getSpeaker({ actor });
  const name = escapeHTML(actor.name);

  const sections = [];
  if (summary.feats.length) {
    sections.push(
      `<p><strong>${localize('messages.global.feats')}</strong></p>` +
        list(summary.feats.map((f) => `@UUID[${f.uuid}]{${escapeHTML(f.name)}} <em>(${escapeHTML(f.slot)})</em>`))
    );
  }
  if (summary.skills.length) {
    sections.push(
      `<p><strong>${localize('messages.global.skills')}</strong></p>` +
        list(summary.skills.map((s) => `${escapeHTML(s.label)}: ${escapeHTML(s.rank)}`))
    );
  }
  if (summary.boosts.length) {
    sections.push(
      `<p><strong>${localize('messages.global.boosts')}</strong> ${summary.boosts
        .map(escapeHTML)
        .join(', ')}</p>`
    );
  }
  if (summary.languages.length) {
    sections.push(
      `<p><strong>${localize('messages.global.languages')}</strong> ${summary.languages
        .map(escapeHTML)
        .join(', ')}</p>`
    );
  }
  if (summary.potency.length) {
    sections.push(
      `<p><strong>${localize('messages.global.potency')}</strong> ${summary.potency
        .map((p) => `${escapeHTML(p.label)} +${p.value}`)
        .join(', ')}</p>`
    );
  }
  if (summary.spells?.length) {
    sections.push(
      `<p><strong>${localize('messages.global.spells')}</strong></p>`,
      list(summary.spells.map((s) => (s.uuid ? `@UUID[${s.uuid}]{${escapeHTML(s.name)}}` : escapeHTML(s.name))))
    );
  }
  if (summary.swaps?.length) {
    sections.push(
      `<p><strong>${localize('messages.global.swaps')}</strong></p>`,
      list(summary.swaps.map((s) => `${escapeHTML(s.from)} → @UUID[${s.uuid}]{${escapeHTML(s.to)}}`))
    );
  }
  if (summary.formulas?.length) {
    sections.push(
      `<p><strong>${localize('messages.global.formulas')}</strong></p>`,
      list(summary.formulas.map((f) => `@UUID[${f.uuid}]{${escapeHTML(f.name)}}`))
    );
  }
  if (!sections.length) {
    sections.push(`<p>${localize('messages.global.noChoices')}</p>`);
  }

  await ChatMessage.create({
    speaker,
    content: `<h2>${localize('messages.global.header', {
      actorName: name,
      targetLevel: plan.targetLevel
    })}</h2>${sections.join('')}`
  });

  // Reminders for the things the system does not automate
  const reminders = [];
  const spellcasting = plan.spellcasting;
  if (spellcasting?.newRank) {
    reminders.push(localize('messages.personal.spellRank', { rank: spellcasting.newRank }));
  }
  if (spellcasting?.entries?.length) {
    reminders.push(
      localize('messages.personal.spellSlots', {
        entries: spellcasting.entries.map((e) => escapeHTML(e.name)).join(', ')
      })
    );
  }
  if (spellHints.length) {
    reminders.push(
      localize('messages.personal.featSpells', {
        feats: spellHints.map(escapeHTML).join(', ')
      })
    );
  }
  const openLanguages = plan.languageSlots - selection.languages.filter(Boolean).length;
  if (openLanguages > 0) {
    reminders.push(localize('messages.personal.languages', { count: openLanguages }));
  }
  const missingSkills = selection.intSkills.filter((s) => !s).length;
  if (missingSkills > 0) {
    reminders.push(localize('messages.personal.intSkill', { count: missingSkills }));
  }
  const emptySlots = plan.slots.current.filter((s) => !selection.feats[s.key]);
  if (emptySlots.length) {
    reminders.push(
      localize('messages.personal.emptySlots', {
        slots: emptySlots.map((s) => escapeHTML(s.groupLabel)).join(', ')
      })
    );
  }
  if (!reminders.length) return;

  const whisper = [game.user.id];
  if (game.settings.get(MODULE_ID, 'send-gm-whispers')) {
    whisper.push(...game.users.filter((u) => u.isGM).map((u) => u.id));
  }

  await ChatMessage.create({
    speaker,
    whisper: [...new Set(whisper)],
    content: `<h3>${localize('messages.personal.header', { actorName: name })}</h3>${list(reminders)}`
  });
};

/**
 * Post a feat's own system chat card. The system only renders cards for owned items, so the card is
 * built from a temporary, unsaved copy parented to the actor.
 */
export const sendFeatToChat = async (uuid, actor) => {
  const feat = await fromUuid(uuid);
  if (!feat) return;
  try {
    const owned = new CONFIG.Item.documentClass(feat.toObject(), { parent: actor });
    await owned.toMessage(null, { create: true });
  } catch (error) {
    console.warn(`${MODULE_ID} | Falling back to a plain feat card`, error);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<h3>@UUID[${uuid}]{${escapeHTML(feat.name)}}</h3>${feat.system?.description?.value ?? ''}`
    });
  }
};
