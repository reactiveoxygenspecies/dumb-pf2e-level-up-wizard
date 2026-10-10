import { I18N } from '../constants.js';

export const localize = (key, data) =>
  data
    ? game.i18n.format(`${I18N}.${key}`, data)
    : game.i18n.localize(`${I18N}.${key}`);

/** Same output as PF2e's sluggify for the plain names found in compendium data */
export const sluggify = (str) => {
  const system = game.pf2e?.system?.sluggify;
  if (system) return system(String(str ?? ''));
  return String(str ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
};

export const renderTemplate = (path, data) =>
  foundry.applications.handlebars.renderTemplate(path, data);

export const enrichHTML = (html, options = {}) =>
  foundry.applications.ux.TextEditor.implementation.enrichHTML(html ?? '', {
    secrets: false,
    ...options
  });

export const escapeHTML = (str) =>
  String(str ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[c]
  );

export const signedNumber = (n) => (n >= 0 ? `+${n}` : `${n}`);

export const rankLabel = (rank) =>
  game.i18n.localize(
    CONFIG.PF2E?.proficiencyLevels?.[rank] ?? `PF2E.ProficiencyLevel${rank}`
  );

export const attributeLabel = (key) =>
  game.i18n.localize(CONFIG.PF2E?.abilities?.[key] ?? key);

/** Every open ApplicationV2 instance, optionally narrowed by class */
export const openApplications = (cls) =>
  Array.from(foundry.applications.instances.values()).filter(
    (app) => !cls || app instanceof cls
  );
