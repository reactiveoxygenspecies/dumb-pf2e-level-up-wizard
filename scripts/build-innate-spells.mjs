#!/usr/bin/env node
/**
 * Generates src/data/innateSpells.json from a checkout of foundryvtt/pf2e (tested against release 8.2.0).
 *
 *   node scripts/build-innate-spells.mjs <path-to-pf2e-checkout> [output.json]
 *
 * The checkout needs (sparse checkout is fine):
 *   packs/pf2e/{spells,feats,heritages,ancestry-features,class-features}
 *
 * HOW IT WORKS
 *   PF2e doesn't add innate spells to the actor. Feats and heritages say it in prose ("You can cast
 *   @UUID[...]{Detect Magic} as an arcane innate spell at will"), so this script reads those sentences:
 *
 *     LINKED  - the sentence links the spells and says "as a(n) ... innate spell". The tradition, a rank
 *               ("4th-rank Silence", "as 2nd-rank primal innate spells"), the uses ("once per day", "twice
 *               per day", "at will") and "heightened to half your level" are read from the same sentence.
 *     CHOSEN  - the item has a ChoiceSet over spells (Fiendish Magic, Methodical Magic): the spell is the
 *               one picked in PF2e's prompt, read from the item on the actor.
 *     LIST    - "Choose one cantrip from the primal spell list" (First World Magic): the player picks in the
 *               module's dialog.
 *
 *   All of it comes from wording, so every grant keeps its sentence (`note`) and the module shows it, asking
 *   the player to check before the spells are added. Sentences that only apply later ("At 8th level, ...")
 *   or under a condition are left out; `_meta.unparsed` lists the items that mention innate spells but gave
 *   no grant, for whoever updates this data.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checkout = process.argv[2];
if (!checkout) {
    console.error("usage: node scripts/build-innate-spells.mjs <pf2e checkout> [output.json]");
    process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = process.argv[3] ?? path.resolve(here, "../src/data/innateSpells.json");
const PACKS = path.join(checkout, "packs/pf2e");

/* ------------------------------------------------------------------------------------------------------------------ */
/* Loading                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

function walk(dir) {
    let out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out = out.concat(walk(p));
        else if (e.name.endsWith(".json") && !e.name.startsWith("_")) out.push(p);
    }
    return out;
}
function sluggify(name) {
    return String(name)
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .replace(/['’]/g, "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
}
/** pack directory -> compendium pack id used in UUIDs */
const PACK_ID = {
    feats: "feats-srd",
    heritages: "heritages",
    "ancestry-features": "ancestryfeatures",
    "class-features": "classfeatures",
    spells: "spells-srd",
};
const loadPack = (dirName) =>
    walk(path.join(PACKS, dirName)).map((f) => {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        return { pack: dirName, j, name: j.name, slug: j.system?.slug || sluggify(j.name), id: j._id };
    });
const uuidOf = (item) => `Compendium.pf2e.${PACK_ID[item.pack]}.Item.${item.id}`;

const spells = new Map(loadPack("spells").map((s) => [s.id, s]));
const sources = ["feats", "heritages", "ancestry-features", "class-features"].flatMap(loadPack);

/* ------------------------------------------------------------------------------------------------------------------ */
/* Description -> sentences with spell markers                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

const SPELL_RE = /@UUID\[Compendium\.pf2e\.spells-srd\.Item\.([^\]]+)\](?:\{[^}]*\})?/g;
const decode = (s) =>
    s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&rsquo;/g, "'");
/** Plain text; spells become ⟦id⟧; block boundaries become newlines */
const toText = (html) =>
    decode(
        (html ?? "")
            .replace(SPELL_RE, (_m, id) => `⟦${id}⟧`)
            .replace(/@[A-Za-z]+\[[^\]]*\](?:\{([^}]*)\})?/g, (_m, label) => label ?? "")
            .replace(/<\/(?:p|li|h\d|tr|div|ul|ol)>|<br\s*\/?>|<hr\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, " "),
    )
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n");
const sentencesOf = (text) =>
    text
        .split(/\n|(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
const idsIn = (s) => [...s.matchAll(/⟦([^⟧]+)⟧/g)].map((m) => m[1]);
const readable = (s) =>
    s
        .replace(/⟦([^⟧]+)⟧/g, (_m, id) => spells.get(id)?.name ?? id)
        .replace(/\s+/g, " ")
        .trim();

/* ------------------------------------------------------------------------------------------------------------------ */
/* Reading a grant                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

const TRADITION = "(arcane|divine|occult|primal)";
const ORDINAL = "(\\d+)(?:st|nd|rd|th)-rank";
/** "as an occult innate spell", "as 2nd-rank primal innate spells", "as innate spells" */
const AS_INNATE = new RegExp(`\\bas (?:an? )?(?:${ORDINAL} )?(?:${TRADITION} )?innate spells?\\b`, "i");
/** Sentences that only apply later or under a condition */
const GATED = /^(?:if|when|whenever|while|until|unless|at \d+(?:st|nd|rd|th) level|increase)\b/i;
const NUMBERS = { two: 2, three: 3, four: 4 };

const usesIn = (s) => {
    if (/\bat will\b/i.test(s)) return { atWill: true, perDay: null };
    if (/\bonce per day\b/i.test(s)) return { atWill: false, perDay: 1 };
    if (/\btwice per day\b/i.test(s)) return { atWill: false, perDay: 2 };
    const times = /\b(\d+|two|three|four) times per day\b/i.exec(s)?.[1];
    if (times) return { atWill: false, perDay: Number(times) || NUMBERS[times.toLowerCase()] };
    // Per hour, per week, every 10 minutes...: the note says it, the sheet tracks nothing
    return { atWill: false, perDay: null };
};

/** The rank every spell of the sentence is cast at, and whether it heightens with the level */
const rankIn = (s) => {
    const rank = AS_INNATE.exec(s)?.[1];
    return {
        ...(rank ? { rank: Number(rank) } : {}),
        ...(/heightened to (?:a spell rank equal to )?half your level/i.test(s) ? { heighten: "half" } : {}),
    };
};

const traditionIn = (s) => (AS_INNATE.exec(s)?.[2] ?? new RegExp(`${TRADITION} innate spells?`, "i").exec(s)?.[1] ?? null)?.toLowerCase() ?? null;

function linkedGrant(sentence) {
    const as = AS_INNATE.exec(sentence);
    if (!as || GATED.test(sentence)) return null;
    const ids = [...new Set(idsIn(sentence))].filter((id) => spells.has(id) && !spells.get(id).j.system.ritual);
    if (!ids.length) return null;
    const allRank = as[1] ? Number(as[1]) : null;
    const half = /heightened to (?:a spell rank equal to )?half your level/i.test(sentence);
    // "either Illusory Object or Invisible Item", "X, Y, or Z": one of them
    const lastTwo = ids.length > 1 ? sentence.slice(sentence.indexOf(`⟦${ids.at(-2)}⟧`), sentence.indexOf(`⟦${ids.at(-1)}⟧`)) : "";
    const oneOf = /^⟦[^⟧]+⟧,? or $/.test(lastTwo.trim() + " ");
    return {
        kind: "linked",
        ...(oneOf ? { choose: 1 } : {}),
        spells: ids.map((id) => {
            const own = new RegExp(`${ORDINAL} ⟦${id}⟧`).exec(sentence)?.[1];
            const rank = own ? Number(own) : allRank;
            return {
                uuid: uuidOf(spells.get(id)),
                ...(rank ? { rank } : {}),
                ...(half ? { heighten: "half" } : {}),
            };
        }),
        tradition: traditionIn(sentence),
        ...usesIn(sentence),
        note: readable(sentence),
    };
}

const out = { _meta: {}, spells: {}, grants: {} };
const unparsed = [];

for (const item of sources) {
    const text = toText(item.j.system.description?.value);
    if (!/innate spell/i.test(text)) continue;
    const sentences = sentencesOf(text);
    const grants = [];

    for (const sentence of sentences) {
        const grant = linkedGrant(sentence);
        if (grant) grants.push(grant);
    }

    // The spell is the one chosen in PF2e's prompt for the item's ChoiceSet
    const innateSentence = sentences.find((s) => AS_INNATE.test(s) && !GATED.test(s));
    if (!grants.length && innateSentence) {
        for (const rule of item.j.system.rules ?? []) {
            if (rule.key !== "ChoiceSet" || rule.choices?.itemType !== "spell" || !rule.flag) continue;
            grants.push({
                kind: "chosen",
                flag: rule.flag,
                slugs: !!rule.choices.slugsAsValues,
                ...rankIn(innateSentence),
                tradition: traditionIn(innateSentence),
                ...usesIn(innateSentence),
                note: readable(innateSentence),
            });
        }
    }

    // "Choose one cantrip from the primal spell list": picked in the module's dialog
    const list = new RegExp(`choose (?:one|a) cantrip from the ${TRADITION} spell list`, "i").exec(text);
    if (!grants.length && list && innateSentence) {
        grants.push({
            kind: "list",
            filter: { tradition: list[1].toLowerCase(), cantrip: true },
            tradition: list[1].toLowerCase(),
            ...usesIn(innateSentence),
            note: readable(`${list[0]}. ${innateSentence}`),
        });
    }

    if (!grants.length) {
        unparsed.push(`${item.pack}/${item.name}`);
        continue;
    }
    if (out.grants[item.slug]) console.warn(`duplicate slug ${item.slug}: ${item.pack}/${item.name} kept second`);
    out.grants[item.slug] = { name: item.name, sourceUuid: uuidOf(item), grants };
    for (const g of grants) {
        for (const s of g.spells ?? []) {
            const spell = spells.get(s.uuid.split(".").pop());
            const traits = spell.j.system.traits;
            out.spells[s.uuid] = {
                name: spell.name,
                rank: spell.j.system.level?.value ?? 1,
                cantrip: traits.value.includes("cantrip"),
            };
        }
    }
}

const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
out.grants = sortObj(out.grants);
out.spells = sortObj(out.spells);
const kinds = Object.values(out.grants).flatMap((g) => g.grants.map((x) => x.kind));
out._meta = {
    source: "foundryvtt/pf2e packs, read by scripts/build-innate-spells.mjs",
    counts: {
        items: Object.keys(out.grants).length,
        linked: kinds.filter((k) => k === "linked").length,
        chosen: kinds.filter((k) => k === "chosen").length,
        list: kinds.filter((k) => k === "list").length,
        unparsed: unparsed.length,
    },
    unparsed: unparsed.sort(),
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${outPath}`);
console.log(JSON.stringify(out._meta.counts));
