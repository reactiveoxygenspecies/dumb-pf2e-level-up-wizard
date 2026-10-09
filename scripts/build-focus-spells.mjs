#!/usr/bin/env node
/**
 * Generates src/data/focusSpells.json from a checkout of foundryvtt/pf2e (tested against release 8.2.0, commit 3c9e8cb).
 *
 *   node scripts/build-focus-spells.mjs <path-to-pf2e-checkout> [output.json]
 *
 * The checkout needs (sparse checkout is fine):
 *   packs/pf2e/{spells,feats,class-features,classes,journals}  and  static/lang/en.json
 *
 * HOW IT WORKS
 *   PF2e 8.2.0 does NOT add focus spells to the actor from class features / feats: only three GrantItem rules in
 *   the whole system point at the spells pack (Awaken Animal, Commune, Harrowing; none is a focus spell). Everything
 *   else is prose ("You gain the @UUID[...] focus spell"). So this script derives the grants from the item
 *   descriptions, in three layers:
 *
 *     1. PARSED FAMILIES   - class-feature families that share a template (sorcerer bloodlines, oracle mysteries,
 *                            wizard schools, druid orders, magus hybrid studies, witch patrons/lessons, psychic
 *                            conscious minds, animist apparitions). Spell names are read from the description.
 *     2. HAND-WRITTEN      - everything in the "HAND-WRITTEN" section below (clearly marked). Each entry names its
 *                            source item and a regular expression that MUST match the item's description; the matched
 *                            sentence becomes the entry's `note`, so a PF2e update that rewords the rule fails the build
 *                            instead of silently shipping stale data.
 *     3. HEURISTIC         - every other feat whose description contains a sentence like "You gain/learn the X focus
 *                            spell" (X linked to a spell in packs/pf2e/spells/focus). `confidence: "heuristic"`.
 *
 *   Spell UUIDs are Compendium.pf2e.spells-srd.Item.<id> (descriptions link by name; names are resolved to ids here).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checkout = process.argv[2];
if (!checkout) {
    console.error("usage: node scripts/build-focus-spells.mjs <pf2e checkout> [output.json]");
    process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = process.argv[3] ?? path.resolve(here, "../src/data/focusSpells.json");
const PACKS = path.join(checkout, "packs/pf2e");

/* ------------------------------------------------------------------------------------------------------------------ */
/* Loading                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

const posix = (p) => p.split(path.sep).join("/");
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
const PACK_ID = { feats: "feats-srd", "class-features": "classfeatures", "ancestry-features": "ancestryfeatures" };

function loadPack(dirName) {
    return walk(path.join(PACKS, dirName)).map((f) => {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        const rel = posix(path.relative(PACKS, f));
        return { pack: dirName, rel, j, name: j.name, slug: sluggify(j.name), id: j._id, level: j.system?.level?.value ?? null };
    });
}

const spellItems = loadPack("spells");
const spellByName = new Map(spellItems.map((s) => [s.name, s]));
const spellUuid = (s) => `Compendium.pf2e.spells-srd.Item.${s.id}`;
const isFocusSpell = (s) => {
    const t = s.j.system.traits;
    return t.value.includes("focus") || (t.value.includes("cantrip") && (t.traditions ?? []).length === 0) || s.rel.includes("/focus/");
};
const isCantrip = (s) => s.j.system.traits.value.includes("cantrip");

const feats = loadPack("feats");
const features = loadPack("class-features");
const classes = loadPack("classes");
const bySlug = { feats: new Map(), "class-features": new Map() };
for (const it of feats) (bySlug.feats.get(it.slug) ?? bySlug.feats.set(it.slug, []).get(it.slug)).push(it);
for (const it of features) (bySlug["class-features"].get(it.slug) ?? bySlug["class-features"].set(it.slug, []).get(it.slug)).push(it);

function find(pack, slug) {
    const hits = bySlug[pack].get(slug) ?? [];
    if (hits.length !== 1) throw new Error(`Expected exactly one ${pack} item with slug "${slug}", found ${hits.length}`);
    return hits[0];
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Description -> text with spell markers                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

const SPELL_RE = /@UUID\[Compendium\.pf2e\.spells-srd\.Item\.([^\]]+)\](?:\{[^}]*\})?/g;
const decode = (s) =>
    s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&rsquo;/g, "'");
/** Plain text; spells become ⟦Name⟧; block boundaries become newlines. */
function toText(html) {
    return decode(
        (html ?? "")
            .replace(SPELL_RE, (_m, n) => `⟦${n}⟧`)
            .replace(/@UUID\[[^\]]*\](?:\{([^}]*)\})?/g, (_m, l) => l ?? "")
            .replace(/@[A-Za-z]+\[[^\]]*\](?:\{([^}]*)\})?/g, (_m, l) => l ?? "")
            .replace(/<\/(?:p|li|h\d|tr|div|ul|ol)>|<br\s*\/?>|<hr\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, " "),
    )
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n");
}
const textOf = new WeakMap();
function descText(item) {
    if (!textOf.has(item)) textOf.set(item, toText(item.j.system.description?.value));
    return textOf.get(item);
}
const namesIn = (s) => [...s.matchAll(/⟦([^⟧]+)⟧/g)].map((m) => m[1]);
const readable = (s) => s.replace(/⟦([^⟧]+)⟧/g, "$1").replace(/\s+/g, " ").trim();
const sentencesOf = (text) =>
    text
        .split(/\n|(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);

/* ------------------------------------------------------------------------------------------------------------------ */
/* Output skeleton                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

const out = { _meta: {}, spells: {}, domains: {}, grants: {} };
const warnings = [];

function ref(name, ctx = "") {
    const s = spellByName.get(name);
    if (!s) {
        warnings.push(`spell "${name}" not found (${ctx})`);
        return null;
    }
    const uuid = spellUuid(s);
    out.spells[uuid] ??= {
        name: s.name,
        rank: s.level,
        cantrip: isCantrip(s),
        focus: isFocusSpell(s),
        traits: s.j.system.traits.value.filter((t) => !["concentrate", "manipulate"].includes(t)),
    };
    return uuid;
}
const refs = (names, ctx) => [...new Set(names)].map((n) => ref(n, ctx)).filter(Boolean);

const TRADITIONS = ["arcane", "divine", "occult", "primal"];
const ATTRS = { strength: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha" };

/** Class groups: where the item comes from (used to pick the focus entry). */
const FEATURE_TAG_CLASS = {
    "sorcerer-bloodline": "sorcerer",
    "oracle-mystery": "oracle",
    "wizard-arcane-school": "wizard",
    "druid-order": "druid",
    "witch-patron": "witch",
    "witch-lesson": "witch",
    "magus-hybrid-study": "magus",
    "animist-apparition": "animist",
    "psychic-conscious-mind": "psychic",
    "champion-cause": "champion",
};
const classOfFeatureName = new Map();
for (const c of classes) for (const i of Object.values(c.j.system.items ?? {})) classOfFeatureName.set(i.name, c.slug);

/** HAND-WRITTEN: class features whose name is not listed in classes/*.json `items` */
const GROUP_OVERRIDE = {
    "hex-spells": "witch",
    envy: "wizard",
    gluttony: "wizard",
    greed: "wizard",
    lust: "wizard",
    pride: "wizard",
    sloth: "wizard",
    wrath: "wizard",
};

function groupOf(item) {
    const m = item.rel.match(/^feats\/(class|archetype|ancestry)\/([^/]+)\//);
    if (m) return m[1] === "class" ? m[2] : `${m[1]}:${m[2]}`;
    if (GROUP_OVERRIDE[item.slug] && item.pack === "class-features") return GROUP_OVERRIDE[item.slug];
    if (item.pack === "class-features") {
        for (const t of item.j.system.traits?.otherTags ?? []) if (FEATURE_TAG_CLASS[t]) return FEATURE_TAG_CLASS[t];
        return classOfFeatureName.get(item.name) ?? null;
    }
    return null;
}

/**
 * HAND-WRITTEN: default focus-entry attributes per source group. `tradition`/`ability` of "class" mean "use the
 * class's own spellcasting tradition / attribute" (the module already knows it); explicit values are for classes
 * whose focus spells are cast with a fixed tradition. Each row cites the feature text it comes from and the regex
 * is checked against that text at build time.
 */
const GROUP_CASTING = {
    cleric: { tradition: "class", ability: "class" },
    druid: { tradition: "class", ability: "class" },
    wizard: { tradition: "class", ability: "class" },
    sorcerer: { tradition: "class", ability: "class" }, // tradition comes from the bloodline
    bard: { tradition: "class", ability: "class" },
    oracle: { tradition: "class", ability: "class" },
    witch: { tradition: "class", ability: "class" }, // tradition comes from the patron
    summoner: { tradition: "class", ability: "class" },
    magus: { tradition: "class", ability: "class" },
    psychic: { tradition: "class", ability: "class" },
    animist: { tradition: "class", ability: "class" },
    champion: {
        tradition: "divine",
        ability: "cha",
        src: ["class-features", "devotion-spells", /Your devotion spells are divine spells\.\s*Your spellcasting attribute is Charisma/],
    },
    ranger: {
        tradition: "primal",
        ability: "wis",
        src: ["class-features", "warden-spells", /Your warden spells are primal spells[\s\S]*Your spellcasting ability is Wisdom/],
    },
    monk: {
        tradition: "choice", // divine or occult, decided when the first qi/ki spell is gained
        ability: "wis",
        src: ["class-features", "ki-spells", /decide whether your ki spells are divine spells or occult spells[\s\S]*key spellcasting ability is Wisdom/],
    },
};
for (const [g, v] of Object.entries(GROUP_CASTING)) {
    if (!v.src) continue;
    const it = find(v.src[0], v.src[1]);
    if (!v.src[2].test(descText(it).replace(/\n/g, " "))) throw new Error(`GROUP_CASTING source for ${g} no longer matches`);
}

function parseCasting(item) {
    const t = descText(item).replace(/\n/g, " ");
    const res = {};
    // "Your Rivethun focus spells are divine spells" / "they are occult psychic spells" / "primal spells"
    const trad = t.match(/\b(?:focus spells?|spells|they(?:'re| are)|they)\s+(?:are |is )?(?:an? )?(arcane|divine|occult|primal)\b/i);
    const trad2 = t.match(/\b(arcane|divine|occult|primal) (?:spell attack|spell DC|focus)/i);
    const trad3 = t.match(/\bas an? (arcane|divine|occult|primal) (?:focus )?spell\b/i);
    const tr = (trad?.[1] ?? trad2?.[1] ?? trad3?.[1])?.toLowerCase();
    if (tr && TRADITIONS.includes(tr)) res.tradition = tr;
    const ab = t.match(/\b(?:spellcasting|key spellcasting) (?:attribute|ability)(?: score)?(?: for [^.]*?)? (?:is|are) (Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\b/i)
        ?? t.match(/using (Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) as your spellcasting/i);
    if (ab) res.ability = ATTRS[ab[1].toLowerCase()];
    return res;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Entry builders                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

function choiceSetFlags(item) {
    return (item.j.system.rules ?? []).filter((r) => r.key === "ChoiceSet" && r.flag).map((r) => r.flag);
}

function baseEntry(item, extra) {
    const group = groupOf(item);
    const casting = { ...(GROUP_CASTING[group] ?? {}), ...parseCasting(item) };
    const e = {
        name: item.name,
        type: item.pack === "feats" ? "feat" : "feature",
        sourceUuid: `Compendium.pf2e.${PACK_ID[item.pack]}.Item.${item.id}`,
        path: item.rel,
        level: item.level,
        group,
        kind: null,
        spells: null,
        focusPoints: null,
        tradition: casting.tradition ?? null,
        ability: casting.ability ?? null,
        choice: null,
        pick: null,
        note: null,
        confidence: "parsed",
        ...extra,
    };
    const flags = choiceSetFlags(item);
    if (flags.length) e.choiceSetFlags = flags;
    if ((item.j.system.traits?.otherTags ?? []).includes("class-archetype")) e.classArchetype = true;
    // focusPoints: 1 if any candidate spell costs a Focus Point, 0 if they are all cantrips (focus cantrips are free)
    const tableTier = e.choice?.table === "domains" ? e.choice.tier : e.pick?.from === "domains" ? e.pick.tier : null;
    const cands = new Set([
        ...(e.spells ?? []),
        ...(e.pick?.options ?? []),
        ...Object.values(e.pick?.map ?? {}).flat(),
        ...Object.values(e.choice?.map ?? {}).flat(),
        ...(tableTier ? Object.values(out.domains).flatMap((d) => d[tableTier]) : []),
    ]);
    const infos = [...cands].map((u) => out.spells[u]).filter(Boolean);
    if (e.focusPoints === null) e.focusPoints = infos.length === 0 ? null : infos.some((s) => !s.cantrip) ? 1 : 0;
    if (infos.length && infos.some((s) => s.cantrip) && infos.some((s) => !s.cantrip)) e.mixedCantripAndSpell = true;
    return e;
}

function put(slug, entry) {
    if (out.grants[slug]) {
        // Same slug used by two items (e.g. a feat and a class feature): disambiguate by suffix and warn.
        warnings.push(`duplicate slug "${slug}" (${out.grants[slug].path} vs ${entry.path}); second stored as "${slug}@${entry.type}"`);
        slug = `${slug}@${entry.type}`;
    }
    out.grants[slug] = entry;
}

/** Find the sentence matching `re` in the item's description (must exist) and return it as a readable quote. */
function quote(item, re) {
    const text = descText(item);
    const flat = text.replace(/\n/g, " ");
    const m = flat.match(re);
    if (!m) throw new Error(`Quote not found in ${item.rel}: ${re}`);
    // widen to the full sentence
    const start = Math.max(flat.lastIndexOf(". ", m.index) + 1, flat.lastIndexOf("] ", m.index) + 1, 0);
    let end = flat.indexOf(". ", m.index + m[0].length);
    end = end === -1 ? flat.length : end + 1;
    return readable(flat.slice(start, end)).slice(0, 400);
}

/** Collect, from a family of items tagged `tag`, a map slug -> {initial,advanced,greater,...} using a parser. */
const familyItems = (tag) => features.filter((f) => (f.j.system.traits?.otherTags ?? []).includes(tag));
const tierMap = (map, tier) => Object.fromEntries(Object.entries(map).filter(([, v]) => v[tier]?.length).map(([k, v]) => [k, v[tier]]));

/* ------------------------------------------------------------------------------------------------------------------ */
/* Domains (deity domain journal)                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

{
    const lang = JSON.parse(fs.readFileSync(path.join(checkout, "static/lang/en.json"), "utf8")).PF2E.Item.Deity.Domain;
    const journal = JSON.parse(fs.readFileSync(path.join(PACKS, "journals/domains.json"), "utf8"));
    const pageByName = new Map(journal.pages.map((p) => [p.name, p]));
    const spellsAfter = (html, label) => {
        const m = html.match(new RegExp(`<strong>${label}</strong>\\s*([^<]*)`));
        return m ? [...m[1].matchAll(/@UUID\[Compendium\.pf2e\.spells-srd\.Item\.([^\]]+)\]/g)].map((x) => x[1]) : [];
    };
    for (const [key, v] of Object.entries(lang)) {
        const slug = sluggify(key);
        const apoc = key.endsWith("Apocryphal");
        const label = v.Label.replace(/ \(apocryphal\)$/, "");
        const page = pageByName.get(`${label} Domain`);
        if (!page) {
            warnings.push(`domain ${slug}: no journal page "${label} Domain"`);
            continue;
        }
        const html = page.text.content;
        const initial = refs(spellsAfter(html, "Domain Spell"), `domain ${slug}`);
        const advanced = refs(spellsAfter(html, "Advanced Domain Spell"), `domain ${slug}`);
        if (!initial.length) warnings.push(`domain ${slug}: no initial domain spell`);
        out.domains[slug] = {
            name: label,
            page: `Compendium.pf2e.journals.JournalEntry.${journal._id}.JournalEntryPage.${page._id}`,
            ...(apoc ? { apocryphalOf: sluggify(key.replace(/Apocryphal$/, "")) } : {}),
            initial,
            advanced,
        };
    }
}
const DOMAIN_TABLE = (tier) => ({ table: "domains", tier });

/* ------------------------------------------------------------------------------------------------------------------ */
/* 1. PARSED FAMILIES                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

const tierRe = (label) =>
    new RegExp(
        `${label}\\s*(?:initial|Initial)[^⟦]*⟦([^⟧]+)⟧(?:\\s*[;,]?\\s*(?:and )?advanced:?[^⟦]*⟦([^⟧]+)⟧)?(?:\\s*[;,]?\\s*(?:and )?greater:?[^⟦]*⟦([^⟧]+)⟧)?`,
    );

function parseTiered(tag, label, ctx, skip = []) {
    const map = {};
    const quotes = {};
    for (const f of familyItems(tag)) {
        if (skip.includes(f.slug)) continue;
        const flat = descText(f).replace(/\n/g, " ");
        const m = flat.match(tierRe(label));
        if (!m) {
            warnings.push(`${ctx}: could not parse "${label}" for ${f.slug}`);
            continue;
        }
        map[f.slug] = {
            initial: refs([m[1]], f.slug),
            advanced: m[2] ? refs([m[2]], f.slug) : [],
            greater: m[3] ? refs([m[3]], f.slug) : [],
        };
        quotes[f.slug] = readable(m[0]);
    }
    return { map, quotes };
}

const FAMILIES = {};

// --- Sorcerer bloodlines: "Bloodline Spells initial: X; advanced: Y; greater: Z"
FAMILIES.bloodline = parseTiered("sorcerer-bloodline", "Bloodline Spells", "sorcerer bloodline");
// --- Oracle mysteries: "Revelation Spells initial: X; advanced: Y; greater: Z"
FAMILIES.mystery = parseTiered("oracle-mystery", "Revelation Spells", "oracle mystery");
// --- Wizard schools: "School Spells initial: X; advanced: Y" (Thassilonian sins use "Initial School Spell X")
FAMILIES.school = parseTiered("wizard-arcane-school", "School Spells", "wizard school", ["runelord"]); // runelord: handled below
{
    // Runelord / Thassilonian: the school gives "Advanced School Spell Personal Runewell"; each sin gives its initial one.
    const thass = find("class-features", "school-of-thassilonian-rune-magic");
    const flat = descText(thass).replace(/\n/g, " ");
    const m = flat.match(/Advanced School Spell ⟦([^⟧]+)⟧/);
    if (m) {
        FAMILIES.school.map[thass.slug] = { initial: [], advanced: refs([m[1]], thass.slug), greater: [] };
        FAMILIES.school.quotes[thass.slug] = `Advanced School Spell ${m[1]} (sin chosen separately, see sins)`;
    }
    FAMILIES.sin = { map: {}, quotes: {} };
    for (const sin of ["envy", "gluttony", "greed", "lust", "pride", "sloth", "wrath"]) {
        const f = find("class-features", sin);
        const mm = descText(f).replace(/\n/g, " ").match(/Initial School Spell ⟦([^⟧]+)⟧/);
        if (!mm) {
            warnings.push(`runelord sin ${sin}: no initial school spell`);
            continue;
        }
        FAMILIES.sin.map[sin] = { initial: refs([mm[1]], sin), advanced: [], greater: [] };
        FAMILIES.sin.quotes[sin] = readable(mm[0]);
    }
}
// --- Druid orders: the focus-linked spell(s) in the order's description ("Order Spell X")
FAMILIES.order = { map: {}, quotes: {} };
for (const f of familyItems("druid-order")) {
    const names = namesIn(descText(f)).filter((n) => spellByName.get(n) && isFocusSpell(spellByName.get(n)));
    if (names.length !== 1) warnings.push(`druid order ${f.slug}: ${names.length} focus spells linked`);
    FAMILIES.order.map[f.slug] = { initial: refs(names, f.slug), advanced: [], greater: [] };
    FAMILIES.order.quotes[f.slug] = readable(descText(f).split("\n").find((l) => /Order Spell|order spell/.test(l)) ?? "");
}
// --- Magus hybrid studies: "Conflux Spell X"
FAMILIES.study = { map: {}, quotes: {} };
for (const f of familyItems("magus-hybrid-study")) {
    const m = descText(f).replace(/\n/g, " ").match(/Conflux Spell ⟦([^⟧]+)⟧/);
    if (!m) {
        warnings.push(`hybrid study ${f.slug}: no conflux spell`);
        continue;
    }
    FAMILIES.study.map[f.slug] = { initial: refs([m[1]], f.slug), advanced: [], greater: [] };
    FAMILIES.study.quotes[f.slug] = readable(m[0]);
}
// --- Witch patrons: "You gain the X hex cantrip"
FAMILIES.patron = { map: {}, quotes: {} };
for (const f of familyItems("witch-patron")) {
    const flat = descText(f).replace(/\n/g, " ");
    const m = flat.match(/You (?:gain|learn) the ⟦([^⟧]+)⟧ hex(?: cantrip)?/);
    if (!m) {
        warnings.push(`witch patron ${f.slug}: no hex cantrip sentence`);
        continue;
    }
    FAMILIES.patron.map[f.slug] = { initial: refs([m[1]], f.slug), advanced: [], greater: [] };
    FAMILIES.patron.quotes[f.slug] = readable(m[0]);
    const tr = flat.match(/Spell List (arcane|divine|occult|primal)/);
    if (tr) (FAMILIES.patron.traditions ??= {})[f.slug] = tr[1];
}
// Sorcerer bloodline tradition ("Tradition arcane"); Draconic is variable (chosen with its own ChoiceSet)
for (const f of familyItems("sorcerer-bloodline")) {
    const first = descText(f).replace(/\n/g, " ").match(/(?:Tradition|Spell List) (\w+)/); // first occurrence only (Draconic lists per-exemplar traditions later)
    (FAMILIES.bloodline.traditions ??= {})[f.slug] = first && TRADITIONS.includes(first[1]) ? first[1] : "variable";
}
// --- Witch lessons: "You gain the X hex" (lesson item level 2/6/10 = basic/greater/major)
FAMILIES.lesson = { map: {}, quotes: {}, levels: {} };
for (const f of familyItems("witch-lesson")) {
    const m = descText(f).replace(/\n/g, " ").match(/You gain the ⟦([^⟧]+)⟧ hex/);
    if (!m) {
        warnings.push(`witch lesson ${f.slug}: no hex sentence`);
        continue;
    }
    FAMILIES.lesson.map[f.slug] = { initial: refs([m[1]], f.slug), advanced: [], greater: [] };
    FAMILIES.lesson.quotes[f.slug] = readable(m[0]);
    FAMILIES.lesson.levels[f.slug] = f.level;
}
// --- Animist apparitions: "Vessel Spell X" (primary apparition only; changes at Refocus)
FAMILIES.apparition = { map: {}, quotes: {} };
for (const f of familyItems("animist-apparition")) {
    const m = descText(f).replace(/\n/g, " ").match(/Vessel Spell ⟦([^⟧]+)⟧/);
    if (!m) {
        warnings.push(`animist apparition ${f.slug}: no vessel spell`);
        continue;
    }
    FAMILIES.apparition.map[f.slug] = { initial: refs([m[1]], f.slug), advanced: [], greater: [] };
    FAMILIES.apparition.quotes[f.slug] = readable(m[0]);
}
// --- Psychic conscious minds: unique psi cantrip ("surface:") is the focus cantrip; "Standard Psi Cantrips" are plain cantrips
FAMILIES.mind = { map: {}, standard: {}, quotes: {} };
for (const f of familyItems("psychic-conscious-mind")) {
    const flat = descText(f).replace(/\n/g, " ");
    const uniq = flat.match(/Unique Psi Cantrips[^⟦]*⟦([^⟧]+)⟧/);
    const deeper = flat.match(/deeper:\s*⟦([^⟧]+)⟧/);
    const deepest = flat.match(/deepest:\s*⟦([^⟧]+)⟧/);
    const stdSection = flat.match(/Standard Psi Cantrips([\s\S]*?)Unique Psi Cantrips/);
    if (!uniq || !deeper || !deepest) {
        warnings.push(`psychic mind ${f.slug}: unique psi cantrips (surface/deeper/deepest) not all found`);
        continue;
    }
    // initial = surface (1st level), advanced = deeper (6th), greater = deepest (10th); all three are automatic
    FAMILIES.mind.map[f.slug] = { initial: refs([uniq[1]], f.slug), advanced: refs([deeper[1]], f.slug), greater: refs([deepest[1]], f.slug) };
    FAMILIES.mind.standard[f.slug] = stdSection ? refs(namesIn(stdSection[1]).filter((n) => /^[A-Z]/.test(n) && spellByName.has(n) && isCantrip(spellByName.get(n)) && !/Amp/.test(n)), f.slug) : [];
    FAMILIES.mind.quotes[f.slug] = readable(uniq[0]);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 2. HAND-WRITTEN entries                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */
/* Every entry below: source item + a regexp that must match its description (used as the quote).                      */

const featureChoice = (family, tag, tier, quoteKey = true) => ({
    type: "feature",
    tag, // the owned feature carries this tag in system.traits.otherTags; its slug is the map key
    tier,
    map: tierMap(FAMILIES[family].map, tier),
    ...(FAMILIES[family].traditions ? { traditionMap: FAMILIES[family].traditions } : {}),
    ...(quoteKey ? { sourceQuotes: FAMILIES[family].quotes } : {}),
});

function hand(pack, slug, re, props) {
    const item = find(pack, slug);
    const note = quote(item, re);
    // props may be a function to allow building after `item` is known
    const p = typeof props === "function" ? props(item) : props;
    put(slug, baseEntry(item, { note, confidence: "curated", ...p }));
}

// ===== SORCERER =====
hand("class-features", "bloodline-spells", /You automatically gain the initial bloodline spell at 1st level/, {
    kind: "choice",
    choice: featureChoice("bloodline", "sorcerer-bloodline", "initial"),
});
hand("feats", "advanced-bloodline", /You gain the advanced bloodline spell associated with your bloodline/, {
    kind: "choice",
    choice: featureChoice("bloodline", "sorcerer-bloodline", "advanced", false),
});
hand("feats", "greater-bloodline", /You gain the greater bloodline spell associated with your bloodline/, {
    kind: "choice",
    choice: featureChoice("bloodline", "sorcerer-bloodline", "greater", false),
});
hand("feats", "basic-bloodline-spell", /You gain your bloodline's initial bloodline spell/, {
    kind: "choice",
    tradition: "bloodline",
    choice: featureChoice("bloodline", "sorcerer-bloodline", "initial", false),
});

// ===== ORACLE =====
hand("class-features", "revelation-spells", /You learn a revelation spell at 1st level and start with a focus pool of 1 Focus Point/, {
    kind: "choice",
    choice: featureChoice("mystery", "oracle-mystery", "initial"),
});
hand("feats", "advanced-revelation", /You learn the advanced revelation spell associated with your mystery/, {
    kind: "choice",
    choice: featureChoice("mystery", "oracle-mystery", "advanced", false),
});
hand("feats", "greater-revelation", /You gain your mystery's greater revelation spell/, {
    kind: "choice",
    choice: featureChoice("mystery", "oracle-mystery", "greater", false),
});
hand("feats", "first-revelation", /You gain your mystery's initial revelation spell/, {
    kind: "choice",
    tradition: "divine",
    choice: featureChoice("mystery", "oracle-mystery", "initial", false),
});
hand("feats", "domain-acumen", /You gain an initial domain spell from that domain, which you cast as a revelation spell/, {
    kind: "pick",
    pick: { from: "domains", scope: "mystery", tier: "initial", note: "Domains listed on the owned oracle-mystery feature ('Domains ...' line); one the actor has no initial domain spell for yet." },
});
hand("feats", "domain-fluency", /You gain an advanced domain spell from that domain, which you cast as a revelation spell/, {
    kind: "pick",
    pick: { from: "domains", scope: "mystery-owned", tier: "advanced", note: "A mystery domain the actor already has the initial spell for." },
});

// ===== WIZARD =====
hand("class-features", "arcane-school", /At 1st level, you choose your arcane school/, {
    kind: "choice",
    choice: {
        ...featureChoice("school", "wizard-arcane-school", "initial"),
        gaps: ["elemental-school: spells are 'the elemental focus spells of your chosen element' (not enumerated in the item); not covered"],
    },
});
hand("feats", "advanced-school-spell", /You gain the advanced school spell for your arcane school/, {
    kind: "choice",
    choice: featureChoice("school", "wizard-arcane-school", "advanced", false),
});
hand("feats", "arcane-school-spell", /You gain your school's initial school spell/, {
    kind: "choice",
    tradition: "arcane",
    choice: featureChoice("school", "wizard-arcane-school", "initial", false),
});
// Thassilonian runelord: sin picks the initial school spell, the school gives the advanced one.
for (const sin of ["envy", "gluttony", "greed", "lust", "pride", "sloth", "wrath"]) {
    const item = find("class-features", sin);
    put(sin, baseEntry(item, {
        kind: "fixed",
        spells: FAMILIES.sin.map[sin].initial,
        note: FAMILIES.sin.quotes[sin],
        confidence: "parsed",
        requires: "runelord class archetype (School of Thassilonian Rune Magic)",
    }));
}

// ===== DRUID =====
hand("class-features", "druidic-order", /grants you a class feat, an order spell/, {
    kind: "choice",
    choice: featureChoice("order", "druid-order", "initial"),
});
hand("feats", "order-magic", /You gain the initial order spell from that order/, {
    kind: "pick",
    pick: { from: "features", tag: "druid-order", tier: "initial", map: tierMap(FAMILIES.order.map, "initial"), note: "An order chosen with Order Explorer (not the druid's own order)." },
});
hand("feats", "order-spell", /You gain the initial order spell from your order/, {
    kind: "choice",
    tradition: "primal",
    choice: featureChoice("order", "druid-order", "initial", false),
});
{
    // "if you're a member of the flame order, you gain Combustion; stone -> Stone Lance; storm -> Powerful Inhalation; wave -> Pulverizing Cascade"
    const item = find("feats", "advanced-elemental-spell");
    const map = {};
    for (const m of descText(item).matchAll(/member of the (\w+) order, you gain ⟦([^⟧]+)⟧/g)) map[`${m[1]}-order`] = refs([m[2]], "advanced-elemental-spell");
    put("advanced-elemental-spell", baseEntry(item, {
        kind: "choice",
        choice: { type: "feature", tag: "druid-order", tier: "elemental", map },
        note: quote(item, /if you're a member of the flame order, you gain/),
        confidence: "curated",
    }));
}

// ===== MAGUS =====
hand("class-features", "conflux-spells", /You learn a conflux spell from your hybrid study/, {
    kind: "choice",
    choice: featureChoice("study", "magus-hybrid-study", "initial"),
});
hand("feats", "hybrid-study-spell", /Gain the conflux spell from a hybrid study of your choice/, {
    kind: "pick",
    tradition: "arcane",
    pick: { from: "features", tag: "magus-hybrid-study", tier: "initial", map: tierMap(FAMILIES.study.map, "initial"), note: "Any hybrid study; the hybrid study's other benefits are not gained." },
});

// ===== WITCH =====
hand("class-features", "hex-spells", /You learn your choice of the ⟦?Patron's Puppet⟧? hex or ⟦?Phase Familiar⟧? hex/, {
    kind: "pick",
    pick: { options: refs(["Patron's Puppet", "Phase Familiar"], "hex-spells"), count: 1 },
});
hand("class-features", "patron", /At 1st level, choose your patron/, {
    kind: "choice",
    choice: { ...featureChoice("patron", "witch-patron", "initial"), note: "Hex cantrip from the patron's first lesson (a focus cantrip: no Focus Point)." },
});
for (const [slug, re, tierName] of [
    ["basic-lesson", /Choose a basic lesson\. You gain its associated hex/, 2],
    ["greater-lesson", /Choose a greater or basic lesson\. You gain its associated hex/, 6],
    ["major-lesson", /Choose a major, greater, or basic lesson\. You gain its associated hex/, 10],
]) {
    hand("feats", slug, re, {
        kind: "pick",
        pick: {
            from: "features",
            tag: "witch-lesson",
            tier: "initial",
            maxFeatureLevel: tierName, // lesson features carry level 2 (basic) / 6 (greater) / 10 (major)
            map: tierMap(FAMILIES.lesson.map, "initial"),
            featureLevels: FAMILIES.lesson.levels,
            sourceQuotes: FAMILIES.lesson.quotes,
        },
    });
}

// ===== BARD / SUMMONER =====
hand("class-features", "composition-spells", /You learn the ⟦?Counter Performance⟧? composition spell/, (item) => ({
    kind: "fixed",
    spells: refs(["Counter Performance", "Courageous Anthem"], "composition-spells"),
    note: `${quote(item, /You learn the ⟦?Counter Performance⟧? composition spell/)} ${quote(item, /You learn the ⟦?Courageous Anthem⟧? composition cantrip/)}`,
}));
hand("class-features", "link-spells", /You learn the ⟦?Evolution Surge⟧? link spell/, (item) => ({
    kind: "fixed",
    spells: refs(["Evolution Surge", "Boost Eidolon"], "link-spells"),
    note: `${quote(item, /You learn the ⟦?Evolution Surge⟧? link spell/)} ${quote(item, /You learn the ⟦?Boost Eidolon⟧? link cantrip/)}`,
}));

// ===== PSYCHIC / ANIMIST =====
hand("class-features", "conscious-mind", /You automatically gain the surface psi cantrip at 1st level, automatically gain the deeper psi cantrip at 6th level, and automatically gain the deepest psi cantrip at 10th level/, {
    kind: "choice",
    choice: {
        ...featureChoice("mind", "psychic-conscious-mind", "initial"),
        // the same feature also gives the 6th-level 'deeper' and 10th-level 'deepest' unique psi cantrip (no later item to hook onto)
        tierLevels: { initial: 1, advanced: 6, greater: 10 },
        tierMaps: { advanced: tierMap(FAMILIES.mind.map, "advanced"), greater: tierMap(FAMILIES.mind.map, "greater") },
        standardPsiCantrips: FAMILIES.mind.standard, // the two non-focus psi cantrips; belong in the spell repertoire, not the focus entry
        note: "Unique psi cantrips are focus cantrips (no Focus Point cost). Psi Cantrips and Amps adds a 2-point focus pool via ActiveEffectLike on system.resources.focus.max.",
    },
});
hand("class-features", "apparition-attunement", /your primary apparition grants you even further power in the form a unique vessel focus spell/, {
    kind: "choice",
    daily: true,
    choice: {
        ...featureChoice("apparition", "animist-apparition", "initial"),
        note: "Attunement is chosen every day and the primary apparition can change at Refocus: the vessel spell swaps accordingly. Not statically resolvable at build time.",
    },
});

// ===== CHAMPION / DOMAINS =====
hand("class-features", "devotion-spells", /Choose either ⟦?Shields of the Spirit⟧? or a spell based on your deity's divine font/, {
    kind: "pick",
    pick: {
        options: refs(["Shields of the Spirit", "Lay on Hands", "Touch of the Void"], "devotion-spells"),
        count: 1,
        conditions: {
            [ref("Lay on Hands")]: "deity:primary:font:heal",
            [ref("Touch of the Void")]: "deity:primary:font:harm",
        },
    },
});
hand("feats", "devout-magic", /You gain a devotion spell of your choice listed in the devotion spells class feature/, {
    kind: "pick",
    tradition: "divine",
    pick: {
        options: refs(["Shields of the Spirit", "Lay on Hands", "Touch of the Void"], "devout-magic"),
        count: 1,
        conditions: { [ref("Lay on Hands")]: "deity:primary:font:heal", [ref("Touch of the Void")]: "deity:primary:font:harm" },
    },
});
hand("feats", "deitys-domain", /You gain the domain's initial domain spell as a devotion spell/, {
    kind: "choice",
    choice: { type: "flag", flag: "deitysDomain", ...DOMAIN_TABLE("initial") },
});
hand("feats", "advanced-deitys-domain", /You gain an advanced domain spell from the domain you chose with Deity's Domain as a devotion spell/, {
    kind: "choice",
    choice: { type: "flagOfFeat", feat: "deitys-domain", flag: "deitysDomain", ...DOMAIN_TABLE("advanced") },
});

// ===== CLERIC =====
hand("feats", "domain-initiate", /You gain an initial domain spell for that domain/, {
    kind: "choice",
    choice: { type: "flag", flag: "domainInitiate", ...DOMAIN_TABLE("initial") },
});
hand("feats", "expanded-domain-initiate", /You gain access to that domain and an initial domain spell for that domain/, {
    kind: "pick",
    pick: { from: "domains", scope: "deity-alternate", tier: "initial", note: "A domain from the deity's alternate domains (system.domains.alternate); not offered by any ChoiceSet in the item." },
});
hand("feats", "advanced-domain", /You gain an advanced domain spell from one of your domains for which you have an initial domain spell/, {
    kind: "pick",
    pick: { from: "domains", scope: "owned", tier: "advanced", note: "One of the domains the actor already has the initial spell for (Domain Initiate flag domainInitiate on each copy of the feat, or Expanded Domain Initiate); a different one each time." },
});

// ===== ARCHETYPE DOMAIN FEATS (no ChoiceSet; the player names a domain, sometimes from a short list) =====
// `domains` = allowed domain slugs when the feat restricts them.
for (const [slug, re, tier, domains, extra] of [
    ["blessing-of-the-sun-gods", /You gain an initial domain spell for that domain/, "initial", ["ambition", "cities", "darkness", "dreams", "family", "fire", "freedom", "healing", "moon", "passion", "sun"], { tradition: "divine", ability: "cha" }],
    ["greater-sun-blessing", /You gain an advanced domain spell from a domain you chose with Blessing of the Sun Gods/, "advanced", null, { scopeFeat: "blessing-of-the-sun-gods" }],
    ["holy-bloom", /You gain the initial domain spell for that domain/, "initial", ["freedom", "zeal"], { ability: "wis" }],
    ["holy-flower", /You gain the advanced domain spell from the domain you chose with Holy Bloom/, "advanced", null, { scopeFeat: "holy-bloom" }],
    ["listeners-boon", /selecting a different domain each time and gaining its domain spell/, "initial", ["fire", "knowledge", "protection", "travel"], {}],
    ["godling-dedication", /You learn the initial domain spell for this domain/, "initial", null, {}],
    ["domain-spirit", /You gain the initial domain spell for that domain/, "initial", null, { tradition: "divine", ability: "wis" }],
    ["advanced-domain-spirit", /You gain the advanced domain spell from the domain granted by your domain spirit/, "advanced", null, { scopeFeat: "domain-spirit" }],
    ["libertys-devotion", /You gain an advanced domain spell from one domain you selected with/, "advanced", null, { scopeFeat: "libertys-promise" }],
    ["advanced-seeker-of-truths", /You gain an advanced domain spell from one domain you selected with Seeker of Truths/, "advanced", null, { scopeFeat: "seeker-of-truths" }],
]) {
    hand("feats", slug, re, {
        kind: "pick",
        pick: { from: "domains", scope: extra.scopeFeat ? "feat-owned" : domains ? "list" : "any", tier, ...(domains ? { domains } : {}), ...(extra.scopeFeat ? { feat: extra.scopeFeat } : {}) },
        ...(extra.tradition ? { tradition: extra.tradition } : {}),
        ...(extra.ability ? { ability: extra.ability } : {}),
    });
}

// ===== MONK / RANGER (pick lists) =====
hand("feats", "qi-spells", /You gain ⟦?Inner Upheaval⟧?, ⟦?Qi Rush⟧?, or another 1st-rank monk qi spell you have access to/, {
    kind: "pick",
    pick: {
        options: refs(["Inner Upheaval", "Qi Rush"], "qi-spells"),
        open: true,
        filter: { traits: ["monk"], rank: 1, note: "or another 1st-rank monk qi spell you have access to" },
    },
});
for (const [slug, names, re] of [
    ["advanced-qi-spells", ["Qi Blast", "Shrink the Span"], /You gain ⟦?Qi Blast⟧?, ⟦?Shrink the Span⟧?, or another 3rd-rank qi spell/],
    ["master-qi-spells", ["Medusa's Wrath", "Touch of Death"], /You gain ⟦?Medusa's Wrath⟧?, ⟦?Touch of Death⟧?, or another 8th-rank qi spell/],
    ["grandmaster-qi-spells", ["Embrace Nothingness", "Qi Form"], /You gain ⟦?Embrace Nothingness⟧?, ⟦?Qi Form⟧?, or another 9th-rank qi spell/],
]) {
    hand("feats", slug, re, { kind: "pick", pick: { options: refs(names, slug), open: true, filter: { traits: ["monk"] } } });
}

/** Ranger "Initiate Warden" family: the description is a bullet list of the options. */
for (const slug of ["initiate-warden", "advanced-warden", "masterful-warden", "peerless-warden"]) {
    const item = find("feats", slug);
    const names = namesIn(descText(item)).filter((n) => spellByName.get(n) && isFocusSpell(spellByName.get(n)));
    put(slug, baseEntry(item, {
        kind: "pick",
        pick: { options: refs(names, slug), count: 1 },
        note: readable(descText(item).split("\n").find((l) => /warden spell|choose|gain/i.test(l)) ?? descText(item).slice(0, 200)),
        confidence: "curated",
    }));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 3. HEURISTIC: other feats / features with "You gain/learn the X ... spell"                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Feats the heuristic matches but which do NOT give the character a focus spell (manually verified). */
const HEURISTIC_EXCLUDE = new Map([
    ["eidolons-wrath", "the eidolon casts the spell, not the summoner"],
    ["witch-lessons", "reference list of all lessons; the hexes come from the patron / Basic, Greater and Major Lesson feats"],
    ["dragon-prince", "innate spell once/day, not a focus spell"],
    ["fey-ascension", "innate spells"],
    ["gift-of-the-hoard", "grants Dragon Breath as an innate-style effect (miscellaneous/aftermath), no focus pool"],
]);
const COND_BEFORE = /\b(if|when|whenever|while|until|unless)\b/i;
const GRANT_VERB = /\b(?:you|You)\s+(?:also\s+)?(?:gain|learn|add)\b|\b(?:you|You) can cast\b(?=[^.]*(?:\bas an? [a-z ]*(?:focus )?spell|devotion spell|focus spell))/;

function heuristicFor(item) {
    const text = descText(item);
    const found = { fixed: [], pick: [], open: false, sentences: [] };
    for (const s of sentencesOf(text)) {
        const names = namesIn(s).filter((n) => spellByName.get(n) && isFocusSpell(spellByName.get(n)));
        if (!names.length) continue;
        const gm = s.match(GRANT_VERB);
        if (!gm) continue;
        const before = s.slice(0, gm.index);
        if (COND_BEFORE.test(before)) continue;
        const after = s.slice(gm.index);
        const afterNames = namesIn(after).filter((n) => names.includes(n));
        if (!afterNames.length) continue;
        // restrict to the part before a following clause that talks about other things? keep whole.
        const isPick = afterNames.length > 1 && /\b(either|or another|your choice|or)\b/i.test(after.replace(/⟦[^⟧]*⟧/g, "X"));
        if (isPick) {
            found.pick.push(...afterNames);
            if (/or another/i.test(after)) found.open = true;
        } else found.fixed.push(...afterNames);
        found.sentences.push(readable(s).slice(0, 360));
    }
    return found;
}

const handled = new Set(Object.keys(out.grants));
for (const item of [...feats, ...features]) {
    if (handled.has(item.slug)) continue;
    if (item.pack === "class-features" && (item.j.system.traits?.otherTags ?? []).some((t) => FEATURE_TAG_CLASS[t])) continue; // parsed family children are folded into their parent entries
    const h = heuristicFor(item);
    if (!h.fixed.length && !h.pick.length) continue;
    if (HEURISTIC_EXCLUDE.has(item.slug)) continue;
    const e = baseEntry(item, {
        kind: h.pick.length && !h.fixed.length ? "pick" : h.fixed.length ? "fixed" : "pick",
        spells: h.fixed.length ? refs(h.fixed, item.slug) : null,
        pick: h.pick.length ? { options: refs(h.pick, item.slug), count: 1, ...(h.open ? { open: true } : {}) } : null,
        note: h.sentences.join(" "),
        confidence: "heuristic",
    });
    put(item.slug, e);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Other bookkeeping                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

// Focus-pool rule elements (system.resources.focus.max) that exist as data in 8.2.0.
const focusPoolRules = [];
for (const item of [...features, ...feats]) {
    for (const r of item.j.system.rules ?? []) {
        if (r.key === "ActiveEffectLike" && r.path === "system.resources.focus.max") focusPoolRules.push({ item: item.rel, name: item.name, mode: r.mode, value: r.value });
    }
}

// Spells that are focus spells by data but never referenced by any grant (coverage report)
const referenced = new Set();
for (const g of Object.values(out.grants)) {
    for (const u of g.spells ?? []) referenced.add(u);
    for (const u of g.pick?.options ?? []) referenced.add(u);
    for (const v of Object.values(g.choice?.map ?? {})) for (const u of v) referenced.add(u);
    for (const v of Object.values(g.pick?.map ?? {})) for (const u of v) referenced.add(u);
}
for (const d of Object.values(out.domains)) for (const u of [...d.initial, ...d.advanced]) referenced.add(u);
const unreferenced = spellItems.filter((s) => isFocusSpell(s) && !referenced.has(spellUuid(s))).map((s) => ({ name: s.name, uuid: spellUuid(s), traits: s.j.system.traits.value.filter((t) => !["concentrate", "manipulate", "focus", "cantrip"].includes(t)) }));

const kinds = {};
for (const g of Object.values(out.grants)) kinds[g.kind] = (kinds[g.kind] ?? 0) + 1;
const conf = {};
for (const g of Object.values(out.grants)) conf[g.confidence] = (conf[g.confidence] ?? 0) + 1;

out._meta = {
    generatedBy: "scripts/build-focus-spells.mjs",
    source: "foundryvtt/pf2e",
    pf2eVersion: (() => {
        try {
            return JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8")).version;
        } catch {
            return null;
        }
    })(),
    kinds: {
        fixed: "Always the same spell(s); PF2e does not add them to the actor.",
        granted: "PF2e already adds the spell item itself via a GrantItem rule (module only has to move it into a focus entry). No focus spell in 8.2.0 has this: see grantItemSpellsInPf2e.",
        choice: "Determined by an earlier choice: choice.type 'feature' = slug of an owned feature carrying choice.tag, 'flag' = flags.pf2e.rulesSelections.<flag> on THIS item (value = domain slug), 'flagOfFeat' = that flag on the owned feat 'feat'. choice.map (or the shared `domains` table) maps the selection to spell UUIDs.",
        pick: "The player picks at grant time from pick.options / pick.map / pick.from ('domains' = see `domains`, 'features' = owned feature tag).",
    },
    traditionValues: "arcane|divine|occult|primal = fixed; 'class' = the class's own spellcasting tradition; 'bloodline' = the owned sorcerer bloodline's tradition; 'choice' = chosen with the first spell (monk: divine or occult); null = not stated.",
    abilityValues: "str|dex|con|int|wis|cha = fixed; 'class' = the class's own spellcasting attribute; null = not stated.",
    confidence: { curated: "hand-written entry whose source sentence is regex-checked", parsed: "template parsed from item descriptions", heuristic: "sentence match 'You gain/learn the X focus spell'; review before trusting" },
    counts: { grants: Object.keys(out.grants).length, byKind: kinds, byConfidence: conf, spells: Object.keys(out.spells).length, domains: Object.keys(out.domains).length },
    grantItemSpellsInPf2e: [],
    focusPoolRuleElements: focusPoolRules,
    focusPoolEngine: "CharacterPF2e.prepareBaseData sets resources.focus {max: 0, cap: 3}; SpellPF2e.prepareActorData adds +1 to resources.focus.max for every owned spell with the 'focus' trait and not the 'cantrip' trait (location irrelevant); CreaturePF2e then clamps max to 0..3. A few features add to it with ActiveEffectLike (focusPoolRuleElements).",
    coverageGaps: [
        "wizard elemental school (spells not enumerated in the item)",
        "cathartic mage 'catharsis emotion' focus spells",
        "archetype 'domain' feats with bespoke domain lists (bright-lion, rose-warden, steel-falcon, godling, rivethun, ...) are heuristic picks, not mapped to the domain table",
        "elementalist class archetype ('elemental-magic') spells",
        "eidolon spells (cast by the eidolon)",
        "mythic / adventure-path archetypes not scanned for hidden prose (only feats + class-features packs were)",
    ],
    unreferencedFocusSpells: unreferenced.length,
    warnings,
};
out._meta.unreferencedFocusSpellList = unreferenced.map((u) => u.name);

// pf2e system GrantItem rules that point at the spells pack (documented answer to "does PF2e grant spells")
for (const item of [...feats, ...features, ...loadPack("ancestry-features"), ...loadPack("heritages"), ...loadPack("backgrounds"), ...classes]) {
    for (const r of item.j.system.rules ?? []) {
        if (r.key === "GrantItem" && /spells-srd/.test(r.uuid ?? "")) {
            const name = String(r.uuid).split(".").pop();
            const s = spellByName.get(name) ?? spellItems.find((x) => x.id === name);
            out._meta.grantItemSpellsInPf2e.push({ item: item.rel, spell: r.uuid, isFocusSpell: s ? isFocusSpell(s) : null, isRitual: s ? !!s.j.system.ritual : null });
        }
    }
}

// Feats/features that GrantItem one of the entries above (e.g. Liberty's Promise grants Domain Initiate): the granted
// item will appear on the actor, so the module sees it directly; this list says who granted it.
{
    const byKey = new Map();
    for (const [slug, g] of Object.entries(out.grants)) {
        const id = g.sourceUuid.split(".").pop();
        byKey.set(id, slug);
        byKey.set(g.name, slug);
    }
    for (const item of [...feats, ...features]) {
        for (const r of item.j.system.rules ?? []) {
            if (r.key !== "GrantItem" || typeof r.uuid !== "string" || r.uuid.includes("{")) continue;
            const target = byKey.get(r.uuid.split(".").pop());
            if (!target || target === item.slug) continue;
            (out.grants[target].grantedBy ??= []).push(item.slug);
        }
    }
}

// stable ordering
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
out.grants = sortObj(out.grants);
out.spells = sortObj(out.spells);
out.domains = sortObj(out.domains);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${outPath}`);
console.log(JSON.stringify(out._meta.counts));
if (warnings.length) {
    console.log(`${warnings.length} warning(s):`);
    for (const w of warnings) console.log("  - " + w);
}
