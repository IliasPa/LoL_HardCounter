// Data Dragon — Riot's free static-data CDN. No API key, CORS enabled.

const DD = 'https://ddragon.leagueoflegends.com';
let cache = null;

export async function loadStaticData() {
  if (cache) return cache;

  const versions = await (await fetch(`${DD}/api/versions.json`)).json();
  const v = versions[0];

  const [champJson, runesJson, itemJson] = await Promise.all([
    fetch(`${DD}/cdn/${v}/data/en_US/champion.json`).then(r => r.json()),
    fetch(`${DD}/cdn/${v}/data/en_US/runesReforged.json`).then(r => r.json()),
    fetch(`${DD}/cdn/${v}/data/en_US/item.json`).then(r => r.json()),
  ]);

  // Champions: index by ddragon id ("MonkeyKing"), numeric key (62) and display name ("Wukong")
  const byId = {}, byKey = {}, byName = {};
  for (const c of Object.values(champJson.data)) {
    const champ = {
      id: c.id,                       // ddragon id, used in match-v5 championName
      key: parseInt(c.key, 10),       // numeric id, used in spectator championId
      name: c.name,                   // display name
      tags: c.tags,                   // ["Fighter","Tank"]...
      info: c.info,                   // {attack, defense, magic, difficulty} 0-10
      icon: `${DD}/cdn/${v}/img/champion/${c.image.full}`,
    };
    byId[champ.id] = champ;
    byKey[champ.key] = champ;
    byName[champ.name.toLowerCase()] = champ;
  }

  // Runes: perkId -> {name, icon}, styleId -> {name, icon}
  const perks = {}, styles = {};
  for (const tree of runesJson) {
    styles[tree.id] = { name: tree.name, icon: `${DD}/cdn/img/${tree.icon}` };
    for (const slot of tree.slots) {
      for (const rune of slot.runes) {
        perks[rune.id] = { name: rune.name, icon: `${DD}/cdn/img/${rune.icon}` };
      }
    }
  }

  // Items: id -> {name, icon, consumable, trinket}
  const items = {};
  for (const [id, it] of Object.entries(itemJson.data)) {
    items[id] = {
      name: it.name,
      icon: `${DD}/cdn/${v}/img/item/${id}.png`,
      consumable: (it.tags || []).includes('Consumable'),
      trinket: (it.tags || []).includes('Trinket'),
    };
  }

  cache = { version: v, byId, byKey, byName, perks, styles, items };
  return cache;
}

// Fuzzy champion search for the autocomplete inputs
export function searchChampions(dd, query, limit = 8) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const all = Object.values(dd.byId);
  const starts = all.filter(c => c.name.toLowerCase().startsWith(q) || c.id.toLowerCase().startsWith(q));
  const contains = all.filter(c => !starts.includes(c) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}
