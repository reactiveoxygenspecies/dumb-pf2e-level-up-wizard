// Builds src/data/spellcasting.json from the PF2e system source.
//
// Usage: node scripts/build-spellcasting.mjs <path to pf2e checkout>
//
// Reads the "spells per day" table of every caster page in
// packs/pf2e/journals/classes.json (level 1-20 rows, "-" = 0, "1*" = 1 with a
// footnote marker, "2+1" = two sources) and merges it with the hand-written
// RULES section below. The rules were written by reading each page's prose and
// the class feature items it embeds (packs/pf2e/class-features/*.json and the
// remaster strings in static/lang/re-en.json). Every rule carries the sentence
// it comes from in `notes`.
//
// The script verifies what it can: 20 rows per table, the footnote markers of
// the cleric (divine font) and magus (studious spells) tables against the extra
// slots derived from the prose, and the class item's key attribute.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
if (!root) {
  console.error('Usage: node scripts/build-spellcasting.mjs <path to pf2e checkout>');
  process.exit(1);
}

const journalPath = path.join(root, 'packs', 'pf2e', 'journals', 'classes.json');
const classesDir = path.join(root, 'packs', 'pf2e', 'classes');
const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'spellcasting.json');

const LEVELS = 20;
const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const levelArray = (fn) => range(LEVELS, (i) => fn(i + 1));

function sluggify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function decode(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(html) {
  return decode(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

/**
 * Parse a cell such as "5", "-", "1*", "1*†", "-*", "2+1", "0+1*", "2+4".
 * Returns { primary, secondary|null, marks }.
 */
function parseCell(raw, where) {
  const m = raw.match(/^(\d+|-)(?:\+(\d+|-))?([*†‡]*)$/);
  if (!m) throw new Error(`Unparseable table cell "${raw}" at ${where}`);
  const num = (s) => (s === '-' ? 0 : Number(s));
  return {
    primary: num(m[1]),
    secondary: m[2] === undefined ? null : num(m[2]),
    marks: m[3] ?? '',
  };
}

function parseSpellTable(pageName, html) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
  const table = tables.find((t) => /<th>Cantrips<\/th>/.test(t) && /<th>10th<\/th>/.test(t));
  if (!table) throw new Error(`${pageName}: no spells-per-day table found`);

  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const dataRows = [];
  const footnotes = [];
  for (const row of rows) {
    if (/colspan/.test(row)) {
      for (const p of row.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
        const text = stripTags(p[1]);
        if (text) footnotes.push(text);
      }
      continue;
    }
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]));
    if (cells.length === 0) continue; // header row
    if (cells.length !== 12) throw new Error(`${pageName}: row has ${cells.length} cells: ${cells.join(' | ')}`);
    dataRows.push(cells);
  }
  if (dataRows.length !== LEVELS) throw new Error(`${pageName}: expected ${LEVELS} level rows, got ${dataRows.length}`);

  const columns = ['cantrips', ...RANKS.map(String)];
  const parsed = {}; // column -> [{primary, secondary, marks}] by level
  for (const c of columns) parsed[c] = [];
  dataRows.forEach((cells, i) => {
    if (Number(cells[0]) !== i + 1) throw new Error(`${pageName}: row ${i} is level ${cells[0]}`);
    columns.forEach((c, k) => parsed[c].push(parseCell(cells[k + 1], `${pageName} level ${i + 1} column ${c}`)));
  });
  return { parsed, footnotes };
}

// ---------------------------------------------------------------------------
// Hand-written rules (from the page prose and the embedded class features)
// ---------------------------------------------------------------------------

/** slots[rank] at a level, 0 when none. */
const slotAt = (slots, rank, level) => slots[String(rank)][level - 1];
const nonZero = (n) => (n > 0 ? 1 : 0);

const RULES = {
  wizard: {
    page: 'Wizard',
    automate: true,
    tradition: 'arcane',
    traditionSource: null,
    preparation: 'prepared',
    signatureSpells: null,
    repertoire: () => null,
    spellbook: {
      cantrips: 10,
      firstRank: 5,
      perLevel: 2,
      curriculum: { firstRank: 2, perNewRank: 1, exceptSchool: 'School of Unified Magical Theory' },
      note:
        'Spellbook "contains your choice of 10 arcane cantrips and five 1st-rank arcane spells." Plus "two 1st-rank spells from the curriculum of your arcane school (except ... the school of unified magical theory)". ' +
        '"Each time you gain a level, you add two arcane spells to your spellbook, of any spell rank for which you have spell slots." ' +
        '"When you gain spell slots of a new rank, you also add an additional spell from your school\'s curriculum (unless it\'s the school of unified magical theory)." ' +
        'The School of Unified Magical Theory instead adds one 1st-rank spell of the player\'s choice to the spellbook.',
    },
    familiar: null,
    extraSlots: ({ slots }) => ({
      perRank: 1,
      fromLevel: 1,
      label: 'Curriculum slot',
      restriction: 'Only spells from the arcane school curriculum of that rank (cantrips: a curriculum cantrip).',
      cantrips: levelArray(() => 1),
      // One extra slot at every rank 1-9 for which the wizard has slots. The 10th-rank slot
      // (Archwizard's Spellcraft) is excluded: it cannot be used with abilities that add slots.
      slots: Object.fromEntries(
        RANKS.map((r) => [String(r), levelArray((lvl) => (r <= 9 ? nonZero(slotAt(slots, r, lvl)) : 0))]),
      ),
      note:
        '"Each day, you can prepare an extra cantrip from your curriculum. You also gain an extra spell slot at each spell rank for which you have wizard spell slots. ' +
        'You can prepare only spells from your school\'s curriculum in these extra slots." Does NOT apply to the School of Unified Magical Theory ("No Curriculum"). ' +
        'Not applied to the 10th-rank slot (Archwizard\'s Spellcraft: "you can\'t use 10th-rank slots with abilities that give you more spell slots").',
    }),
    notes:
      'Arcane thesis "Spell Blending" lets the wizard trade two slots of one rank for a bonus slot up to two ranks higher (and slots for cantrips) during daily preparation; not modelled. ' +
      'The 10th-rank slot (table footnote) comes from Archwizard\'s Spellcraft at 19th level: "You gain a single 10th-rank spell slot ... You don\'t gain more 10th-rank spells as you level up, but you can take the Archwizard\'s Might feat to gain a second slot." ' +
      'Table footnote: "The Archwizard\'s Spellcraft class feature gives you a 10th-rank spell slot that works a bit differently from other spell slots."',
  },

  cleric: {
    page: 'Cleric',
    automate: true,
    tradition: 'divine',
    traditionSource: null,
    preparation: 'prepared',
    signatureSpells: null,
    repertoire: () => null,
    spellbook: null,
    familiar: null,
    extraSlots: ({ slots }) => ({
      label: 'Divine font',
      restriction: 'Only heal (healing font) or harm (harmful font), depending on the deity / choice. Slots are at the cleric\'s highest rank of spell slot (1st-9th).',
      highestRankOnly: true,
      cantrips: null,
      slots: Object.fromEntries(
        RANKS.map((r) => [
          String(r),
          levelArray((lvl) => {
            // highest rank 1-9 the cleric has slots in at this level
            const highest = Math.max(0, ...RANKS.filter((k) => k <= 9 && slotAt(slots, k, lvl) > 0));
            if (r !== highest) return 0;
            return lvl >= 15 ? 6 : lvl >= 5 ? 5 : 4;
          }),
        ]),
      ),
      note:
        'Divine Font: "You gain 4 additional spell slots each day at your highest rank of cleric spell slots ... At 5th level, the number of additional slots increases to 5, and at 15th level, the total number of additional slots increases to 6." ' +
        'Table footnote: "Your divine font gives you additional heal or harm spells of this rank. The number is 4 at 1st level, 5 at 5th level, and 6 at 15th level." ' +
        'The table puts the "*" marker on the 10th-rank cell at 19th-20th level as well; the Divine Font and Miraculous Spell text say 10th-rank slots cannot be used with abilities that add slots, so the font is kept at 9th rank at 19th-20th level here (INTERPRETATION).',
    }),
    notes:
      'The "*" on a rank in the table marks the rank that receives the divine font slots. Table footnote: "The miraculous spell class feature gives you a 10th-rank spell slot that works a bit differently from other spell slots." ' +
      'Miraculous Spell: "You gain a single 10th-rank spell slot and can prepare a spell in that slot using cleric spellcasting ... You don\'t gain more 10th-rank spells as you level up, but you can take the Maker of Miracles feat to gain a second slot."',
  },

  druid: {
    page: 'Druid',
    automate: true,
    tradition: 'primal',
    traditionSource: null,
    preparation: 'prepared',
    signatureSpells: null,
    repertoire: () => null,
    spellbook: null,
    familiar: null,
    extraSlots: () => null,
    notes:
      '"At 1st level, you can prepare two 1st-rank spells and five cantrips each morning from the common spells on the primal spell list, or from other primal spells to which you gain access and learn via Learn a Spell." ' +
      'Table footnote: "The primal hierophant class feature gives you a 10th-rank spell slot that works a bit differently from other spell slots." (A second slot needs the Hierophant\'s Power feat.) Druidic order spells are focus spells and not modelled.',
  },

  bard: {
    page: 'Bard',
    automate: true,
    tradition: 'occult',
    traditionSource: null,
    preparation: 'spontaneous',
    signatureSpells: { fromLevel: 3, mode: 'onePerRank' },
    repertoire: ({ slots }) => ({
      cantrips: levelArray(() => 5),
      // "Each time you get a spell slot ... you add a spell to your spell repertoire of the same rank."
      ranks: Object.fromEntries(
        RANKS.map((r) => [String(r), levelArray((lvl) => (r === 10 ? (slotAt(slots, 10, lvl) > 0 ? 2 : 0) : slotAt(slots, r, lvl)))]),
      ),
      granted: null,
      note:
        '"At 1st level, you learn two 1st-rank occult spells of your choice and five occult cantrips of your choice ... Each time you get a spell slot ... you add a spell to your spell repertoire of the same rank. At 2nd level, you select another 1st-rank spell; at 3rd level, you select two 2nd-rank spells, and so on." ' +
        'So known spells per rank equal the slots per rank. 10th rank: Magnum Opus says "Add two common 10th-rank occult spells to your repertoire. You gain a single 10th-rank spell slot", hence 2 known and 1 slot.',
    }),
    spellbook: null,
    familiar: null,
    extraSlots: () => null,
    notes:
      'Table footnote: "The magnum opus class feature gives you a 10th-rank spell slot that works a bit differently from other spell slots." Spell slots and repertoire are separate ("If a feat or other ability adds a spell to your spell repertoire, it wouldn\'t give you another spell slot"). Signature Spells at 3rd level: "For each spell rank you have access to, choose one spell of that rank to be a signature spell." Composition (focus) spells are not modelled.',
  },

  sorcerer: {
    page: 'Sorcerer',
    automate: true,
    tradition: null,
    traditionSource: 'bloodline',
    preparation: 'spontaneous',
    signatureSpells: { fromLevel: 3, mode: 'onePerRank' },
    repertoire: ({ slots }) => ({
      cantrips: levelArray(() => 5),
      ranks: Object.fromEntries(
        RANKS.map((r) => [String(r), levelArray((lvl) => (r === 10 ? (slotAt(slots, 10, lvl) > 0 ? 2 : 0) : slotAt(slots, r, lvl)))]),
      ),
      // Spells automatically in the repertoire because of the bloodline (included in the totals above).
      granted: {
        cantrips: levelArray(() => 1),
        ranks: Object.fromEntries(RANKS.map((r) => [String(r), levelArray((lvl) => (r <= 9 ? nonZero(slotAt(slots, r, lvl)) : 0))])),
      },
      note:
        '"At 1st level, you learn two 1st-rank spells of your choice and four cantrips of your choice, as well as an additional spell and cantrip from your bloodline ... Each time you get a spell slot ... you add a spell to your spell repertoire of the same rank. ' +
        'When you gain a new rank of spells, your first new spell is always the sorcerous gift spell for that rank that\'s listed in your bloodline ... At 2nd level, you select another 1st-rank spell; at 3rd level, you gain a new spell from your bloodline and two other 2nd-rank spells." ' +
        'Totals per rank therefore equal the slots (3 first-rank spells at 1st level = 2 chosen + 1 bloodline); `granted` is the bloodline part of those totals. Cantrips: 4 chosen + 1 bloodline = 5. ' +
        '10th rank: Bloodline Paragon says "Add two common 10th-rank spells of your tradition to your repertoire. You gain a single 10th-rank spell slot".',
    }),
    spellbook: null,
    familiar: null,
    extraSlots: () => null,
    notes:
      'The tradition is set by the bloodline ("The tradition from which your spells come is determined by your bloodline"); the bloodline item picks arcane, divine, occult or primal (e.g. draconic = arcane, per the Bloodline list on the page). ' +
      'Table footnote: "The bloodline paragon class feature gives you a 10th-rank spell slot that works a bit differently from other spell slots." Bloodline (focus) spells are not modelled.',
  },

  oracle: {
    page: 'Oracle',
    automate: true,
    tradition: 'divine',
    traditionSource: null,
    preparation: 'spontaneous',
    signatureSpells: { fromLevel: 3, mode: 'onePerRank' },
    repertoire: ({ slots }) => ({
      cantrips: levelArray(() => 5),
      ranks: Object.fromEntries(
        RANKS.map((r) => [String(r), levelArray((lvl) => (r === 10 ? (slotAt(slots, 10, lvl) > 0 ? 2 : 0) : slotAt(slots, r, lvl)))]),
      ),
      granted: null,
      note:
        'The page\'s repertoire text (re-en.json SpecificRule.ClassFeatures.SpellRepertoire.oracle): "At 1st level, you learn three 1st-rank divine spells of your choice and five divine cantrips of your choice ... Each time you get a spell slot ... you add a spell to your spell repertoire of the same rank. At 2nd level, you select another 1st-rank spell; at 3rd level, you select three 2nd-rank spells, and so on." ' +
        'Known spells per rank equal the slots per rank. 10th rank: Oracular Clarity says "Add two common 10th-rank divine spells to your repertoire. You gain a single 10th-rank spell slot". ' +
        'NOTE: the separate class-feature item "Spell Repertoire (Oracle)" (spell-repertoire-oracle.json) says "two 1st-rank divine spells" and "two 2nd-rank spells"; it is not what the journal page shows and contradicts the 3 slots per rank in the table, so the journal text was followed.',
    }),
    spellbook: null,
    familiar: null,
    extraSlots: () => null,
    notes:
      'Table footnote: "The oracular clarity class feature gives you a 10th-rank spell slot that works differently from other spell slots." Mystery and cursebound (focus spells, curse stages) are not modelled.',
  },

  psychic: {
    page: 'Psychic',
    automate: true,
    tradition: 'occult',
    traditionSource: null,
    preparation: 'spontaneous',
    signatureSpells: { fromLevel: 3, mode: 'onePerRank' },
    repertoire: ({ slots }) => {
      // chosen spells = slots; the conscious mind adds one granted spell per rank 1-9 and psi cantrips.
      const grantedCantrips = levelArray((lvl) => (lvl >= 10 ? 5 : lvl >= 6 ? 4 : 3));
      return {
        cantrips: levelArray((lvl) => 3 + grantedCantrips[lvl - 1]),
        ranks: Object.fromEntries(
          RANKS.map((r) => [
            String(r),
            levelArray((lvl) => {
              if (r === 10) return slotAt(slots, 10, lvl) > 0 ? 2 : 0;
              const s = slotAt(slots, r, lvl);
              return s > 0 ? s + 1 : 0;
            }),
          ]),
        ),
        granted: {
          cantrips: grantedCantrips,
          ranks: Object.fromEntries(RANKS.map((r) => [String(r), levelArray((lvl) => (r <= 9 ? nonZero(slotAt(slots, r, lvl)) : 0))])),
        },
        note:
          '"At 1st level, you learn one 1st-rank occult spell of your choice and three occult cantrips of your choice ... Your choice of conscious mind also grants you additional spells in your repertoire, starting with an additional 1st-rank spell and two cantrips listed in your conscious mind, which you cast as psi cantrips. ' +
          'Each time you get a spell slot, you add a spell to your spell repertoire of the same rank. At 2nd level, you select another 1st-rank spell; at 3rd level, you select one 2nd-rank spell". ' +
          'Conscious Mind: "At 1st level, you gain a 1st-rank spell, and you learn the other spells on the list as soon as you gain the ability to cast psychic spells of that rank, learning the 2nd-rank spell at 3rd level, the 3rd-rank spell at 5th level, and so on"; ' +
          'cantrips: two standard psi cantrips + the unique surface psi cantrip at 1st level, "the deeper psi cantrip at 6th level, and ... the deepest psi cantrip at 10th level". ' +
          'Totals = chosen (= slots) + `granted` (INTERPRETATION: the conscious mind grants exactly one spell per rank 1st-9th and 3/4/5 psi cantrips at levels 1/6/10; the table\'s "3*" cantrips are the three chosen cantrips). ' +
          '10th rank: Infinite Mind says "Add two common 10th-rank occult spells to your repertoire".',
      };
    },
    spellbook: null,
    familiar: null,
    extraSlots: () => null,
    notes:
      'Key attribute depends on the subconscious mind (Cha or Int), not the class item (keyAbility is empty). Table footnotes: "* Your conscious mind gives you three additional cantrips with amps. One cantrip is unique to your conscious mind." ' +
      'and "The infinite mind class feature gives you a 10th-rank spell slot". The journal table shows 2 tenth-rank slots at level 20 (1 at level 19), but Infinite Mind itself only grants "a single 10th-rank spell slot" (the Mind Over Matter feat gives a second): the table value is kept as printed, which looks like a source inconsistency (UNCERTAIN, may over-count by 1 at level 20 for characters without Mind Over Matter).',
  },

  summoner: {
    page: 'Summoner',
    automate: true,
    tradition: null,
    traditionSource: 'eidolon',
    preparation: 'spontaneous',
    dropsLowerRanks: true,
    signatureSpells: { fromLevel: 3, mode: 'all' },
    repertoire: () => ({
      cantrips: levelArray(() => 5),
      // The repertoire cannot be broken down by rank from the prose (see note); only its total size is fixed.
      ranks: null,
      total: levelArray((lvl) => Math.min(5, lvl + 1)),
      granted: null,
      note:
        '"At 1st level, you learn two 1st-level spells of your choice and five cantrips of your choice ... At 2nd level, you select another 1st-level spell. At 3rd level, you add the first 2nd-level spell to your repertoire. At 4th level you gain your second and your spell repertoire reaches its maximum size of five spells." ' +
        '"At 5th level, in addition to adding two 3rd-level spells to your repertoire, you lose your lowest level of spell slots. Any time you lose a level of spell slots, you lose two spells in your repertoire as well." ' +
        'Total size = 2, 3, 4, then 5 from 4th level on. The split per rank is the player\'s choice (only constraint: "you must keep at least one spell you can cast with your lowest rank of spell slots"), so `ranks` is null. ' +
        'INTERPRETATION: the maximum of five is taken to hold at every later level (each new rank adds two spells and drops two).',
    }),
    spellbook: null,
    familiar: null,
    extraSlots: () => null,
    notes:
      'The tradition is determined by the eidolon ("your eidolon determines the type of spells you cast and the spell list you choose from"). ' +
      'The class loses lower-rank slots as it levels: "Because of the way you draw magic from your eidolon, you begin to lose lower-rank spell slots once you reach 5th level. The maximum number of spell slots you get from the summoner class is four, starting when you reach 4th level." ' +
      'Slot counts per rank therefore go up and then back to 0; "For anything that requires the ability to cast spells of a certain rank that\'s lower than the highest slots you have, you still qualify even if you no longer have spell slots at those ranks." ' +
      'Unlimited Signature Spells at 3rd level: "All of your spells are signature spells." Link spells (focus) are not modelled. The table has no 10th-rank column entries (no 10th-rank slot).',
  },

  magus: {
    page: 'Magus',
    automate: true,
    tradition: 'arcane',
    traditionSource: null,
    preparation: 'prepared',
    dropsLowerRanks: true,
    signatureSpells: null,
    repertoire: () => null,
    spellbook: {
      cantrips: 8,
      firstRank: 4,
      perLevel: 2,
      curriculum: null,
      note:
        'Spellbook: "The spellbook contains your choice of eight arcane cantrips and four 1st-rank arcane spells." "Each time you gain a level, you add two more arcane spells to your spellbook, of any rank of spell you can cast." ' +
        '"Though you lose some lower spell slots as you increase in level, you keep the spells in your spellbook and can prepare them in your higher-rank slots as normal."',
    },
    familiar: null,
    extraSlots: ({ marks }) => {
      // Studious spells: two special slots at 2nd rank (7th level), 3rd rank (11th), 4th rank (13th).
      const rankAt = (lvl) => (lvl >= 13 ? 4 : lvl >= 11 ? 3 : lvl >= 7 ? 2 : 0);
      const slots = Object.fromEntries(RANKS.map((r) => [String(r), levelArray((lvl) => (rankAt(lvl) === r ? 2 : 0))]));
      // cross-check against the "-*" cells of the table
      for (const r of RANKS) {
        levelArray((lvl) => {
          const marked = (marks[String(r)]?.[String(lvl)] ?? '').includes('*');
          if (marked !== (rankAt(lvl) === r)) {
            throw new Error(`magus studious spell slots disagree with table marker at rank ${r} level ${lvl}`);
          }
          return 0;
        });
      }
      return {
        label: 'Studious spell slot',
        restriction: 'Only for the studious spells: gecko grip, sure strike, water breathing, haste (11th+), fly (13th+) and the spell(s) given by the hybrid study; they are added to the spellbook.',
        cantrips: null,
        slots,
        note:
          'Studious Spells (7th level): "You gain two special 2nd-rank studious spell slots ... At 11th level, the extra slots increase to 3rd-rank ... At 13th level, the extra slots increase to 4th-rank". ' +
          'Matches the "-*" cells of the table (footnote: "The studious spells class feature gives you extra slots of this rank for specific spells").',
      };
    },
    notes:
      '"At 1st level, you can prepare one 1st-rank spell and five cantrips each morning from the spells in your spellbook." "Because you split your focus between physical training and magical scholarship, you have no more than two spell slots of your highest rank and, if you can cast 2nd-rank spells or higher, two spell slots of 1 rank lower than your highest spell rank." ' +
      'Hence lower ranks drop to 0 as the magus levels (1st rank is gone at 5th level) while the highest two ranks keep 2 slots each. ' +
      'Spellstrike, Arcane Cascade and conflux (focus) spells are not modelled. The table has no 10th-rank slots.',
  },

  witch: {
    page: 'Witch',
    automate: true,
    tradition: null,
    traditionSource: 'patron',
    preparation: 'prepared',
    signatureSpells: null,
    repertoire: () => null,
    spellbook: null,
    familiar: {
      cantrips: 10,
      firstRank: 5,
      perLevel: 2,
      patronLesson: 1,
      note:
        'Familiar (Witch): "Your familiar starts off knowing 10 cantrips, five 1st-rank spells, and one additional spell determined by your patron\'s initial lesson. You choose these spells from the common spells of the tradition determined by your patron ... ' +
        'Each time you gain a level, your patron teaches your familiar two new spells of any rank for which you have spell slots, chosen from common spells of your tradition or others you gain access to."',
    },
    extraSlots: () => null,
    notes:
      '"At 1st level, you can prepare up to two 1st-rank spells and five cantrips each morning from the spells your familiar knows." The tradition is set by the patron ("choose your patron, which determines your spellcasting tradition"). ' +
      'Table footnote: "The patron conduit class feature gives you a 10th-rank spell slot that works a bit differently from other spell slots." (Patron\'s Gift, 19th level; a second slot needs the Patron\'s Truth feat.) Hexes and lessons (focus spells) are not modelled.',
  },

  animist: {
    page: 'Animist',
    automate: false,
    tradition: 'divine',
    traditionSource: null,
    preparation: 'prepared',
    signatureSpells: { fromLevel: 1, mode: 'apparitionSpellsOnly' },
    repertoire: () => null,
    spellbook: null,
    familiar: null,
    extraSlots: () => null,
    notes:
      'NOT AUTOMATED: the animist has two separate casting sources that cannot share slots ("you can\'t cast your animist spells using your apparition spell slots or vice versa"). ' +
      '`cantrips` and `slots` hold the first number of each table cell (animist spellcasting, PREPARED: "Each day, you can prepare one 1st-rank spell and 2 cantrips from among the common spells on the divine spell list"); ' +
      '`secondary` holds the number after the plus sign (apparition spellcasting, SPONTANEOUS: "You gain additional spontaneous spell slots and a spell repertoire from your attuned apparitions. At first level, you can cast two apparition cantrips and one 1st-rank apparition spell per day"). ' +
      'Table note: "The number before a plus sign indicates your spell slots via animist spellcasting, and the number after it indicates your spell slots from apparition spellcasting." ' +
      'The apparition repertoire is not a class number: it is "a collection of spells granted to you by all your attuned apparitions" (two apparitions, three at 7th level, four at 15th), so its size depends on the apparition entries and is not in the journal. ' +
      '"All your apparition spells are signature spells." Table footnote: "The supreme apparition class feature gives you a 10th-rank apparition slot that works a bit differently from other spells." (Supreme Incarnation, 19th level.) Vessel spells (focus) are not modelled.',
    secondary: {
      preparation: 'spontaneous',
      source: 'apparitions',
    },
  },
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));

function classItem(slug) {
  const file = path.join(classesDir, `${slug}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const out = {};
for (const [slug, rule] of Object.entries(RULES)) {
  const page = journal.pages.find((p) => p.name === rule.page);
  if (!page) throw new Error(`No journal page named ${rule.page}`);
  const item = classItem(slug);
  if (sluggify(item.name) !== slug) throw new Error(`Class item ${slug} is named ${item.name}`);

  const { parsed, footnotes } = parseSpellTable(rule.page, page.text.content);

  const dual = RULES[slug].secondary !== undefined;
  const cantrips = parsed.cantrips.map((c) => c.primary);
  const slots = {};
  for (const r of RANKS) slots[String(r)] = parsed[String(r)].map((c) => c.primary);

  // footnote markers: { column: { level: marker } }
  const marks = {};
  for (const [col, cells] of Object.entries(parsed)) {
    cells.forEach((c, i) => {
      if (c.marks) (marks[col] ??= {})[String(i + 1)] = c.marks;
    });
  }

  const entry = {
    name: item.name,
    automate: rule.automate,
    tradition: rule.tradition,
    traditionSource: rule.traditionSource,
    preparation: rule.preparation,
    keyAbility: item.system.keyAbility?.value ?? [],
    dropsLowerRanks: rule.dropsLowerRanks === true,
    cantrips,
    slots,
  };

  if (dual) {
    entry.secondary = {
      preparation: rule.secondary.preparation,
      source: rule.secondary.source,
      cantrips: parsed.cantrips.map((c) => c.secondary ?? 0),
      slots: Object.fromEntries(RANKS.map((r) => [String(r), parsed[String(r)].map((c) => c.secondary ?? 0)])),
    };
  } else {
    for (const [col, cells] of Object.entries(parsed)) {
      if (cells.some((c) => c.secondary !== null)) throw new Error(`${slug}: unexpected "a+b" cell in column ${col}`);
    }
  }

  const ctx = { slots, cantrips, marks };
  entry.signatureSpells = rule.signatureSpells;
  entry.extraSlots = rule.extraSlots(ctx);
  entry.repertoire = rule.repertoire(ctx);
  entry.spellbook = rule.spellbook;
  entry.familiar = rule.familiar;
  entry.footnotes = footnotes;
  entry.marks = marks;
  entry.notes = rule.notes;

  out[slug] = entry;
}

// Cleric: the "*" markers must sit on the rank that receives the divine font slots (levels 1-18).
{
  const cleric = out.cleric;
  for (let lvl = 1; lvl <= 18; lvl++) {
    for (const r of RANKS) {
      const marked = (cleric.marks[String(r)]?.[String(lvl)] ?? '').includes('*');
      const font = cleric.extraSlots.slots[String(r)][lvl - 1] > 0;
      if (marked !== font) throw new Error(`cleric divine font disagrees with table marker at rank ${r} level ${lvl}`);
    }
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
// Keep the 20-value number arrays on one line so the file stays reviewable.
const json = JSON.stringify(out, null, 2).replace(/\[\s*(-?\d+(?:,\s*-?\d+)*)\s*\]/g, (_, body) => `[${body.replace(/\s+/g, ' ')}]`);
fs.writeFileSync(outPath, json + '\n');
console.log(`Wrote ${Object.keys(out).length} classes to ${outPath}`);
