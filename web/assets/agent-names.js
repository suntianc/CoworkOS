// Begin with the constellations bordering Triangulum Australe, home to the star Atria,
// then continue through the southern sky and the remaining IAU constellations.
const constellations = [
  "Ara",
  "Norma",
  "Circinus",
  "Apus",
  "Pavo",
  "Crux",
  "Carina",
  "Vela",
  "Musca",
  "Volans",
  "Dorado",
  "Tucana",
  "Hydrus",
  "Phoenix",
  "Grus",
  "Indus",
  "Octans",
  "Reticulum",
  "Pictor",
  "Mensa",
  "Chamaeleon",
  "Centaurus",
  "Lupus",
  "Horologium",
  "Triangulum Australe",
  "Eridanus",
  "Fornax",
  "Sculptor",
  "Caelum",
  "Columba",
  "Puppis",
  "Pyxis",
  "Antlia",
  "Telescopium",
  "Microscopium",
  "Corona Australis",
  "Sagittarius",
  "Scorpius",
  "Libra",
  "Hydra",
  "Corvus",
  "Crater",
  "Sextans",
  "Lepus",
  "Canis Major",
  "Canis Minor",
  "Monoceros",
  "Orion",
  "Taurus",
  "Auriga",
  "Gemini",
  "Cancer",
  "Leo",
  "Leo Minor",
  "Virgo",
  "Coma Berenices",
  "Bootes",
  "Corona Borealis",
  "Hercules",
  "Ophiuchus",
  "Serpens",
  "Scutum",
  "Aquila",
  "Lyra",
  "Cygnus",
  "Sagitta",
  "Vulpecula",
  "Delphinus",
  "Equuleus",
  "Pegasus",
  "Aquarius",
  "Capricornus",
  "Piscis Austrinus",
  "Pisces",
  "Cetus",
  "Aries",
  "Triangulum",
  "Andromeda",
  "Perseus",
  "Cassiopeia",
  "Cepheus",
  "Lacerta",
  "Draco",
  "Ursa Minor",
  "Ursa Major",
  "Canes Venatici",
  "Lynx",
  "Camelopardalis"
];

/** A durable ID always has the same name, including in older task snapshots.
 * @param {string} agentId
 * @returns {string}
 */
export function agentDisplayName(agentId) {
  if (agentId === "main") return "Formicand";
  const number = /^subagent[_-](\d+)$/.exec(agentId)?.[1];
  const index =
    number && Number.isSafeInteger(Number(number))
      ? Math.max(0, Number(number) - 1)
      : [...agentId].reduce((hash, char) => (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0, 0);
  // Letter designations keep names unique once all 88 constellations are used.
  let generation = Math.floor(index / constellations.length);
  let designation = "";
  while (generation > 0) {
    designation = String.fromCharCode(65 + ((generation - 1) % 26)) + designation;
    generation = Math.floor((generation - 1) / 26);
  }
  return constellations[index % constellations.length] + (designation ? ` ${designation}` : "");
}

/** The display name of one agent, including names persisted by older snapshots.
 * @param {Record<string, any>} [agent]
 * @returns {string}
 */
export function agentName(agent = {}) {
  if (agent.__main || agent.agentId === "main") return "Formicand";
  if (/^subagent[_-]\d+$/.test(agent.agentId || "")) return agentDisplayName(agent.agentId);
  return agent.name || (agent.agentId ? agentDisplayName(agent.agentId) : "");
}
